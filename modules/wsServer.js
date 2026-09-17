/**
 * WebSocket server for on-site interface clients.
 *
 * The esGate Java app (and later ELC) holds an open socket here. That gives
 * two things a polling design cannot: a disconnect is detected the moment the
 * socket closes rather than after a heartbeat goes stale, and the cloud has a
 * channel to push commands down - remote restart and datasync.
 *
 * Every inbound message is data, never instruction. A client can report its
 * own state and acknowledge commands; it cannot ask EIS to do anything else.
 *
 * Authentication happens once, on the hello message. The credentials are
 * verified against eslink.online rather than against the database here,
 * because the apps table is PHP's to own and duplicating its password
 * handling would put two implementations of the same check in the system.
 */

'use strict';

const WebSocket = require( 'ws' );
const axios     = require( 'axios' );
const crypto    = require( 'crypto' );

const config = require( '../config/config' );
const logger = require( './logger' );
const status = require( './statusRepository' );

/** Connected clients keyed by property_id + client_type */
const clients = new Map();

/** Commands awaiting acknowledgement, keyed by command_id */
const pendingCommands = new Map();

/** Deliveries pushed to an ELC and awaiting its ack, keyed by delivery_id */
const pendingDeliveries = new Map();

let wss = null;
let heartbeatTimer = null;

/**
 * @description Builds the map key for a client
 * @param {string} propertyId - Property
 * @param {string} clientType - esgate_interface | elc
 * @returns {string}
 */
function clientKey( propertyId, clientType ) {
    return propertyId + ':' + clientType;
}

/**
 * @description Sends a JSON message to a socket, ignoring a closed one
 * @param {object} ws - WebSocket
 * @param {object} message - Object to send
 * @returns {void}
 */
function send( ws, message ) {
    if ( ws.readyState === WebSocket.OPEN ) {
        ws.send( JSON.stringify( message ) );
    }
}

/**
 * @description Verifies app credentials against eslink.online.
 *
 * Returns true only on a successful token issue. A network failure returns
 * false, which means a client cannot register while eslink.online is down -
 * deliberately, since registering an unverified client would be worse.
 *
 * @param {string} appId - Application ID from the hello message
 * @param {string} appSecret - Application secret from the hello message
 * @returns {Promise<boolean>}
 */
async function verifyCredentials( appId, appSecret ) {

    try {
        const form = new URLSearchParams();
        form.append( 'what_do_you_want', 'scodezy_authenticate_app' );
        form.append( 'app_id', appId );
        form.append( 'app_secret', appSecret );

        const response = await axios.post( config.eslinkApi.url, form.toString(), {
            timeout: config.eslinkApi.timeout,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        } );

        let body = response.data;
        if ( typeof body === 'string' ) {
            body = JSON.parse( body );
        }
        if ( Array.isArray( body ) ) {
            body = body[ 0 ];
        }

        return !!( body && body.type === 'success' );
    }
    catch ( err ) {
        logger.warn( 'Credential check failed for app ' + appId + ' : ' + err.message );
        return false;
    }
}

/**
 * @description Handles the hello handshake - authenticates, binds the client
 *              to its property and marks it connected
 * @param {object} ws - Socket
 * @param {object} message - Parsed hello message
 * @returns {Promise<void>}
 */
async function handleHello( ws, message ) {

    const appId      = String( message.app_id || '' );
    const appSecret  = String( message.app_secret || '' );
    const propertyId = String( message.property_id || '' );
    const clientType = String( message.client_type || 'esgate_interface' );

    if ( !appId || !appSecret || !propertyId ) {
        send( ws, { type: 'hello_ack', accepted: false,
                    reason: 'app_id, app_secret and property_id are all required' } );
        ws.close( 4001, 'Incomplete hello' );
        return;
    }

    if ( clientType !== 'esgate_interface' && clientType !== 'elc' ) {
        send( ws, { type: 'hello_ack', accepted: false,
                    reason: 'Unrecognised client_type' } );
        ws.close( 4002, 'Bad client type' );
        return;
    }

    const credentialsOk = await verifyCredentials( appId, appSecret );

    if ( !credentialsOk ) {
        logger.warn( 'Rejected ' + clientType + ' for property ' + propertyId
                     + ' from ' + ws._remoteAddress + ' - bad credentials' );
        send( ws, { type: 'hello_ack', accepted: false,
                    reason: 'Authentication failed' } );
        ws.close( 4003, 'Authentication failed' );
        return;
    }

    /* Holding valid credentials is not the same as being entitled to this
       property - a client from hotel A must not register against hotel B */
    const linked = await status.isAppLinkedToProperty( appId, propertyId );

    if ( !linked ) {
        logger.warn( 'Rejected app ' + appId + ' for property ' + propertyId
                     + ' - not linked in property_apps' );
        send( ws, { type: 'hello_ack', accepted: false,
                    reason: 'This application is not linked to the requested property' } );
        ws.close( 4004, 'Not linked to property' );
        return;
    }

    const configuration = await status.getInterfaceConfiguration( propertyId, clientType );

    if ( !configuration ) {
        send( ws, { type: 'hello_ack', accepted: false,
                    reason: 'No interface configuration exists for this property' } );
        ws.close( 4005, 'No configuration' );
        return;
    }

    if ( Number( configuration.enabled ) !== 1 || Number( configuration.archived ) !== 0 ) {
        send( ws, { type: 'hello_ack', accepted: false,
                    reason: 'This interface is disabled' } );
        ws.close( 4006, 'Interface disabled' );
        return;
    }

    const key = clientKey( propertyId, clientType );

    /* A half-dead socket plus a reconnect leaves two connections claiming the
       same property. Last one wins - the new socket is demonstrably alive,
       the old one may be a zombie that would swallow commands. */
    const existing = clients.get( key );
    if ( existing && existing.ws !== ws ) {
        logger.info( 'Replacing an existing connection for ' + key );
        existing.replaced = true;
        try { existing.ws.close( 4007, 'Replaced by a newer connection' ); }
        catch ( err ) { /* already gone */ }
    }

    const client = {
        ws: ws,
        key: key,
        appId: appId,
        propertyId: propertyId,
        clientType: clientType,
        interfaceConfigurationId: configuration.interface_configuration_id,
        appVersion:    String( message.app_version || '' ),
        interfacePcIp: String( message.interface_pc_ip || '' ),
        osInfo:        String( message.os_info || '' ),
        remoteAddress: ws._remoteAddress,
        connectedAt:   Date.now(),
        isAlive:       true,
        replaced:      false
    };

    ws._client = client;
    clients.set( key, client );

    await status.markInterfaceConnected( client );

    logger.info( 'Registered ' + clientType + ' for property ' + propertyId
                 + ' from ' + client.remoteAddress
                 + ' (version ' + ( client.appVersion || 'unknown' ) + ')' );

    send( ws, {
        type: 'hello_ack',
        accepted: true,
        server_time: Date.now(),
        heartbeat_interval: config.ws.expectedHeartbeatInterval
    } );
}

/**
 * @description Handles a PMS link state change reported by a client
 * @param {object} client - Registered client
 * @param {object} message - Parsed pms_status message
 * @returns {Promise<void>}
 */
async function handlePmsStatus( client, message ) {

    const connected = message.connected === true || message.connected === 'true';
    const reason    = String( message.reason || '' );

    await status.updatePmsLinkStatus( client, connected, reason );

    logger.info( 'Property ' + client.propertyId + ' reports PMS link '
                 + ( connected ? 'UP' : 'DOWN' )
                 + ( reason ? ' - ' + reason : '' ) );
}

/**
 * @description Handles a heartbeat from a client
 * @param {object} client - Registered client
 * @param {object} message - Parsed heartbeat message
 * @returns {Promise<void>}
 */
async function handleHeartbeat( client, message ) {

    const pmsConnected = message.pms_connected === true
                         || message.pms_connected === 'true';

    await status.recordHeartbeat( client, pmsConnected );

    send( client.ws, { type: 'heartbeat_ack', server_time: Date.now() } );

    logger.debug( 'Heartbeat from ' + client.key
                  + ' (PMS ' + ( pmsConnected ? 'up' : 'down' ) + ')' );
}

/**
 * @description Handles a client's acknowledgement of a pushed command
 * @param {object} client - Registered client
 * @param {object} message - Parsed command_ack message
 * @returns {void}
 */
function handleCommandAck( client, message ) {

    const commandId = String( message.command_id || '' );
    const pending   = pendingCommands.get( commandId );

    if ( !pending ) {
        logger.debug( 'Acknowledgement for unknown command ' + commandId );
        return;
    }

    pendingCommands.delete( commandId );

    logger.info( 'Command ' + pending.action + ' (' + commandId + ') on '
                 + client.key + ' : '
                 + ( message.accepted ? 'accepted' : 'refused' )
                 + ( message.detail ? ' - ' + message.detail : '' ) );

    status.recordHistory( client.propertyId, 'app', client.interfaceConfigurationId,
        message.accepted ? 'connected' : 'disconnected',
        'Command ' + pending.action + ' '
        + ( message.accepted ? 'accepted' : 'refused' )
        + ( message.detail ? ' : ' + message.detail : '' ) );
}

/**
 * @description Routes one inbound message
 * @param {object} ws - Socket
 * @param {string} raw - Raw frame
 * @returns {Promise<void>}
 */
async function handleMessage( ws, raw ) {

    let message;

    try {
        message = JSON.parse( raw );
    }
    catch ( err ) {
        logger.warn( 'Discarded unparseable frame from ' + ws._remoteAddress );
        return;
    }

    if ( !message || typeof message !== 'object' ) {
        return;
    }

    /* hello is the only message accepted before registration */
    if ( message.type === 'hello' ) {
        await handleHello( ws, message );
        return;
    }

    const client = ws._client;

    if ( !client ) {
        send( ws, { type: 'error', reason: 'Send hello before anything else' } );
        ws.close( 4008, 'Not registered' );
        return;
    }

    switch ( message.type ) {

        case 'pms_status':
            await handlePmsStatus( client, message );
            break;

        case 'heartbeat':
            await handleHeartbeat( client, message );
            break;

        case 'command_ack':
            handleCommandAck( client, message );
            break;

        case 'deliver_ack':
            handleDeliverAck( client, message );
            break;

        case 'endpoint_status':
            handleEndpointStatus( client, message );
            break;

        default:
            logger.debug( 'Unhandled message type "' + message.type
                          + '" from ' + client.key );
            break;
    }
}

/**
 * @description Resolves a delivery that an ELC has acknowledged.
 *
 * The queue row stays in_flight on the EIS side until this arrives, so all
 * retry state lives in one place and ELC never needs a queue of its own.
 *
 * @param {object} client - The ELC that acknowledged
 * @param {object} message - Parsed deliver_ack message
 * @returns {void}
 */
function handleDeliverAck( client, message ) {

    const deliveryId = String( message.delivery_id || '' );
    const pending    = pendingDeliveries.get( deliveryId );

    if ( !pending ) {
        // Almost always a late ack for a delivery EIS already timed out
        logger.debug( 'Acknowledgement for unknown delivery ' + deliveryId );
        return;
    }

    pendingDeliveries.delete( deliveryId );
    clearTimeout( pending.timer );

    pending.resolve( {
        success: message.success === true,
        stage:   String( message.stage || 'endpoint_rejected' ),
        message: String( message.message || '' )
    } );
}

/**
 * @description Records an endpoint reachability report from an ELC.
 *
 * ELC probes its local endpoints, so EIS can distinguish "the hotel relay is
 * up but the pfSense is down" from a generic delivery failure.
 *
 * @param {object} client - The reporting ELC
 * @param {object} message - Parsed endpoint_status message
 * @returns {Promise<void>}
 */
async function handleEndpointStatus( client, message ) {

    const endpointId = String( message.endpoint_id || '' );
    const reachable  = message.reachable === true;

    if ( !endpointId ) {
        return;
    }

    await status.updateEndpointReachability( client.propertyId, endpointId,
                                             reachable, String( message.detail || '' ) );

    logger.debug( 'ELC at property ' + client.propertyId + ' reports endpoint '
                  + endpointId + ' ' + ( reachable ? 'reachable' : 'UNREACHABLE' ) );
}

/**
 * @description Pushes one delivery to the property's ELC and waits for its ack.
 *
 * Resolves with the same shape deliveryService.deliver() returns, so the
 * queue processor handles a direct and a relayed delivery identically.
 *
 * @param {string} propertyId - Property whose ELC should deliver this
 * @param {object} row - The claimed queue row
 * @param {object} payload - Parsed payload
 * @returns {Promise<object>} { success, stage, message }
 */
function pushDelivery( propertyId, row, payload ) {

    const client = clients.get( clientKey( propertyId, 'elc' ) );

    if ( !client || client.ws.readyState !== WebSocket.OPEN ) {
        return Promise.resolve( {
            success: false,
            stage: 'elc_unreachable',
            message: 'No ELC is connected for property ' + propertyId
        } );
    }

    const deliveryId = crypto.randomBytes( 8 ).toString( 'hex' );

    return new Promise( function( resolve ) {

        /* An ELC that accepts a delivery then dies would otherwise hold this
           room's FIFO open indefinitely */
        const timer = setTimeout( function() {
            pendingDeliveries.delete( deliveryId );
            resolve( {
                success: false,
                stage: 'elc_unreachable',
                message: 'ELC did not acknowledge within '
                         + ( config.ws.deliveryAckTimeout / 1000 ) + ' seconds'
            } );
        }, config.ws.deliveryAckTimeout );

        pendingDeliveries.set( deliveryId, { resolve: resolve, timer: timer } );

        send( client.ws, {
            type: 'deliver',
            delivery_id: deliveryId,
            queue_id: row.id,
            property_id: row.property_id,
            endpoint_id: row.endpoint_id,
            endpoint_url: row.endpoint_url,
            endpoint_type: row.endpoint_type,
            verb: row.verb,
            room_no: row.room_no,
            payload: payload
        } );

        logger.debug( 'Pushed delivery ' + deliveryId + ' (queue row ' + row.id
                      + ') to ELC at property ' + propertyId );
    } );
}

/**
 * @description Reports whether an ELC is currently connected for a property
 * @param {string} propertyId - Property
 * @returns {boolean}
 */
function isElcConnected( propertyId ) {
    const client = clients.get( clientKey( propertyId, 'elc' ) );
    return !!( client && client.ws.readyState === WebSocket.OPEN );
}

/**
 * @description Pushes a command to a connected client.
 *
 * Commands are rejected rather than queued when the client is offline. A
 * datasync that runs six hours late, against state that has moved on, is
 * worse than one that never ran - and a restart is moot, because a
 * disconnected app re-registers when it comes back anyway.
 *
 * @param {string} propertyId - Target property
 * @param {string} clientType - esgate_interface | elc
 * @param {string} action - restart | datasync
 * @param {object} params - Optional action parameters
 * @returns {object} { success, command_id } or { success: false, reason }
 */
function pushCommand( propertyId, clientType, action, params ) {

    const client = clients.get( clientKey( propertyId, clientType ) );

    if ( !client || client.ws.readyState !== WebSocket.OPEN ) {
        return { success: false, reason: 'No ' + clientType
                 + ' is connected for property ' + propertyId };
    }

    const commandId = crypto.randomBytes( 8 ).toString( 'hex' );

    pendingCommands.set( commandId, {
        action: action,
        propertyId: propertyId,
        issuedAt: Date.now()
    } );

    send( client.ws, {
        type: 'command',
        command_id: commandId,
        action: action,
        params: params || {}
    } );

    logger.info( 'Pushed ' + action + ' (' + commandId + ') to ' + client.key );

    /* Give up waiting eventually, so the map cannot grow without bound */
    setTimeout( function() {
        if ( pendingCommands.has( commandId ) ) {
            pendingCommands.delete( commandId );
            logger.warn( 'Command ' + action + ' (' + commandId
                         + ') was never acknowledged' );
        }
    }, config.ws.commandAckTimeout );

    return { success: true, command_id: commandId };
}

/**
 * @description Returns a summary of connected clients, for the status endpoint
 * @returns {Array}
 */
function listClients() {

    const list = [];

    clients.forEach( function( c ) {
        list.push( {
            property_id:  c.propertyId,
            client_type:  c.clientType,
            app_version:  c.appVersion,
            remote:       c.remoteAddress,
            connected_at: c.connectedAt,
            uptime_s:     Math.floor( ( Date.now() - c.connectedAt ) / 1000 )
        } );
    } );

    return list;
}

/**
 * @description Starts the WebSocket server
 * @returns {void}
 */
function start() {

    wss = new WebSocket.Server( {
        host: config.ws.host,
        port: config.ws.port,
        // A hotel PC on a slow link should not be cut off mid-frame
        maxPayload: 256 * 1024
    } );

    wss.on( 'connection', function( ws, req ) {

        /* Behind a proxy the socket address is the proxy, so prefer the
           forwarded header when one is present */
        ws._remoteAddress = ( req.headers[ 'x-forwarded-for' ] || '' ).split( ',' )[ 0 ].trim()
                            || req.socket.remoteAddress;

        logger.debug( 'Socket opened from ' + ws._remoteAddress );

        ws.on( 'pong', function() {
            if ( ws._client ) {
                ws._client.isAlive = true;
            }
        } );

        ws.on( 'message', function( raw ) {
            handleMessage( ws, raw ).catch( function( err ) {
                logger.error( 'Error handling a frame from ' + ws._remoteAddress
                              + ' : ' + err.message );
            } );
        } );

        ws.on( 'error', function( err ) {
            logger.warn( 'Socket error from ' + ws._remoteAddress + ' : ' + err.message );
        } );

        ws.on( 'close', function( code, reason ) {

            const client = ws._client;

            if ( !client ) {
                logger.debug( 'Unregistered socket closed from ' + ws._remoteAddress );
                return;
            }

            /* A replaced socket must not clear the status its replacement
               has already set */
            if ( client.replaced ) {
                logger.debug( 'Replaced socket for ' + client.key + ' closed' );
                return;
            }

            clients.delete( client.key );

            const detail = 'Socket closed (' + code + ')'
                           + ( reason ? ' : ' + reason : '' );

            status.markInterfaceDisconnected( client, detail )
                .catch( function( err ) {
                    logger.error( 'Could not record the disconnect for '
                                  + client.key + ' : ' + err.message );
                } );

            logger.info( 'Lost ' + client.clientType + ' for property '
                         + client.propertyId + ' - ' + detail );
        } );

        /* An unauthenticated socket must not sit open indefinitely */
        setTimeout( function() {
            if ( !ws._client && ws.readyState === WebSocket.OPEN ) {
                logger.warn( 'Closing a socket from ' + ws._remoteAddress
                             + ' that never sent hello' );
                ws.close( 4009, 'Hello timeout' );
            }
        }, config.ws.helloTimeout );
    } );

    wss.on( 'error', function( err ) {
        logger.error( 'WebSocket server error : ' + err.message );
    } );

    /* A TCP socket can stay open long after the peer has gone. Ping-pong is
       what distinguishes a quiet client from a vanished one. */
    heartbeatTimer = setInterval( function() {

        wss.clients.forEach( function( ws ) {

            if ( ws._client && ws._client.isAlive === false ) {
                logger.warn( 'No pong from ' + ws._client.key + ', terminating' );
                ws.terminate();
                return;
            }

            if ( ws._client ) {
                ws._client.isAlive = false;
            }

            try { ws.ping(); } catch ( err ) { /* socket already gone */ }
        } );

    }, config.ws.pingInterval );

    logger.info( 'WebSocket server listening on ws://' + config.ws.host
                 + ':' + config.ws.port );
}

/**
 * @description Stops the WebSocket server and closes every client socket
 * @returns {Promise<void>}
 */
function stop() {

    if ( heartbeatTimer ) {
        clearInterval( heartbeatTimer );
        heartbeatTimer = null;
    }

    if ( !wss ) {
        return Promise.resolve();
    }

    return new Promise( function( resolve ) {
        wss.clients.forEach( function( ws ) {
            try { ws.close( 1001, 'Server shutting down' ); }
            catch ( err ) { /* ignore */ }
        } );
        wss.close( function() {
            wss = null;
            resolve();
        } );
    } );
}

module.exports = {
    start: start,
    stop: stop,
    pushCommand: pushCommand,
    pushDelivery: pushDelivery,
    isElcConnected: isElcConnected,
    listClients: listClients
};
