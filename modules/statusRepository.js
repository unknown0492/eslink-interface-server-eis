/**
 * Status persistence for connected interface clients.
 *
 * Kept separate from database.js, which owns the delivery queue. Both talk to
 * the same pool, but the queue and the status tables are independent concerns
 * and mixing their SQL in one module made it hard to read.
 *
 * Every state change also writes a row to connection_status_history, because
 * the current-state columns answer "is it up now" while the history answers
 * "how often has it dropped this week", and support needs both.
 */

'use strict';

const logger = require( './logger' );

let pool = null;

/**
 * @description Receives the pool created by database.js
 * @param {object} sharedPool - mysql2 promise pool
 * @returns {void}
 */
function usePool( sharedPool ) {
    pool = sharedPool;
}

/**
 * @description Records a connection or state event in the history table
 * @param {string} propertyId - Property concerned
 * @param {string} subjectType - app | pms | endpoint
 * @param {string} subjectId - The subject's business key
 * @param {string} event - connected | disconnected | reconnected | alert_sent | recovered
 * @param {string} detail - Free text reason
 * @returns {Promise<void>}
 */
async function recordHistory( propertyId, subjectType, subjectId, event, detail ) {

    try {
        await pool.query(
            "INSERT INTO connection_status_history "
            + "( property_id, subject_type, subject_id, event, detail, event_timestamp ) "
            + "VALUES ( ?, ?, ?, ?, ?, ? )",
            [ propertyId, subjectType, subjectId, event,
              String( detail || '' ).substring( 0, 500 ), Date.now() ]
        );
    }
    catch ( err ) {
        // History is useful but never worth failing a status update over
        logger.warn( 'Could not write connection history : ' + err.message );
    }
}

/**
 * @description Confirms an app is linked to a property and the link is active.
 *
 * This is the same check checkAppPropertyBinding() performs in PHP. It stops
 * a client that holds valid credentials for one property from registering
 * itself against another.
 *
 * @param {string} appId - Calling application's ID
 * @param {string} propertyId - Property it claims to serve
 * @returns {Promise<boolean>}
 */
async function isAppLinkedToProperty( appId, propertyId ) {

    const [ rows ] = await pool.query(
        "SELECT id FROM property_apps "
        + "WHERE app_id=? AND property_id=? AND active='1' LIMIT 1",
        [ appId, propertyId ]
    );

    return rows.length > 0;
}

/**
 * @description Loads the interface_configurations row for a property and
 *              client type, creating nothing - a client with no row is
 *              rejected rather than silently provisioned
 * @param {string} propertyId - Property
 * @param {string} clientType - esgate_interface | elc
 * @returns {Promise<object|null>}
 */
async function getInterfaceConfiguration( propertyId, clientType ) {

    const [ rows ] = await pool.query(
        "SELECT interface_configuration_id, property_id, client_type, app_id, "
        + "       enabled, archived "
        + "FROM interface_configurations "
        + "WHERE property_id=? AND client_type=? LIMIT 1",
        [ propertyId, clientType ]
    );

    return rows.length > 0 ? rows[ 0 ] : null;
}

/**
 * @description Marks an interface client connected and records the details it
 *              reported about itself
 * @param {object} client - Registered client context
 * @returns {Promise<void>}
 */
async function markInterfaceConnected( client ) {

    const now = Date.now();

    await pool.query(
        "UPDATE interface_configurations SET "
        + "  is_connected='1', connection_begin_timestamp=?, "
        + "  last_communication_timestamp=?, app_version=?, interface_pc_ip=?, "
        + "  os_info=?, updated_on=? "
        + "WHERE interface_configuration_id=?",
        [ now, now, client.appVersion || '', client.interfacePcIp || '',
          client.osInfo || '', now, client.interfaceConfigurationId ]
    );

    await recordHistory( client.propertyId, 'app', client.interfaceConfigurationId,
                         'connected',
                         client.clientType + ' connected from ' + client.remoteAddress );
}

/**
 * @description Marks an interface client disconnected.
 *
 * The PMS link is marked down at the same time. The interface is the only
 * thing that can report on that link, so once it is gone the PMS state is
 * unknown - and showing it as still connected would be a lie support would
 * act on.
 *
 * @param {object} client - The client context that just dropped
 * @param {string} reason - Why the socket closed
 * @returns {Promise<void>}
 */
async function markInterfaceDisconnected( client, reason ) {

    const now = Date.now();

    await pool.query(
        "UPDATE interface_configurations SET is_connected='0', updated_on=? "
        + "WHERE interface_configuration_id=?",
        [ now, client.interfaceConfigurationId ]
    );

    await recordHistory( client.propertyId, 'app', client.interfaceConfigurationId,
                         'disconnected', reason );

    const [ result ] = await pool.query(
        "UPDATE property_pms SET is_connected='0', updated_on=? "
        + "WHERE property_id=? AND is_connected='1'",
        [ now, client.propertyId ]
    );

    if ( result.affectedRows > 0 ) {
        const pmsId = await getPropertyPmsId( client.propertyId );
        await recordHistory( client.propertyId, 'pms', pmsId || '', 'disconnected',
                             'Interface disconnected, PMS link state is now unknown' );
    }
}

/**
 * @description Looks up the property_pms business key for a property
 * @param {string} propertyId - Property
 * @returns {Promise<string|null>}
 */
async function getPropertyPmsId( propertyId ) {

    const [ rows ] = await pool.query(
        "SELECT property_pms_id FROM property_pms "
        + "WHERE property_id=? AND enabled='1' AND archived='0' LIMIT 1",
        [ propertyId ]
    );

    return rows.length > 0 ? rows[ 0 ].property_pms_id : null;
}

/**
 * @description Applies a PMS link state change reported by an interface
 * @param {object} client - Reporting client
 * @param {boolean} connected - Whether the interface can currently talk to the PMS
 * @param {string} reason - Detail for the history row
 * @returns {Promise<boolean>} True when a row was updated
 */
async function updatePmsLinkStatus( client, connected, reason ) {

    const now      = Date.now();
    const propertyPmsId = await getPropertyPmsId( client.propertyId );

    if ( !propertyPmsId ) {
        logger.warn( 'Property ' + client.propertyId
                     + ' reported PMS status but has no property_pms row' );
        return false;
    }

    /* Only stamp connection_begin_timestamp on a transition into connected,
       so the CMS can show how long the link has been up rather than how long
       ago the last heartbeat was */
    let sql;
    let params;

    if ( connected ) {
        sql = "UPDATE property_pms SET is_connected='1', "
            + "    connection_begin_timestamp = IF( is_connected='1', "
            + "        connection_begin_timestamp, ? ), "
            + "    last_communication_timestamp=?, updated_on=? "
            + "WHERE property_pms_id=?";
        params = [ now, now, now, propertyPmsId ];
    }
    else {
        sql = "UPDATE property_pms SET is_connected='0', updated_on=? "
            + "WHERE property_pms_id=?";
        params = [ now, propertyPmsId ];
    }

    const [ result ] = await pool.query( sql, params );

    await recordHistory( client.propertyId, 'pms', propertyPmsId,
                         connected ? 'connected' : 'disconnected', reason );

    return result.affectedRows > 0;
}

/**
 * @description Refreshes the heartbeat timestamps for a connected client
 * @param {object} client - Reporting client
 * @param {boolean} pmsConnected - PMS link state carried in the heartbeat
 * @returns {Promise<void>}
 */
async function recordHeartbeat( client, pmsConnected ) {

    const now = Date.now();

    await pool.query(
        "UPDATE interface_configurations "
        + "SET last_communication_timestamp=?, updated_on=? "
        + "WHERE interface_configuration_id=?",
        [ now, now, client.interfaceConfigurationId ]
    );

    /* The PMS timestamp only moves while the link is actually up. Refreshing
       it during an outage would make a dead link look healthy to the
       monitoring cron. */
    if ( pmsConnected ) {
        await pool.query(
            "UPDATE property_pms SET last_communication_timestamp=?, updated_on=? "
            + "WHERE property_id=? AND is_connected='1'",
            [ now, now, client.propertyId ]
        );
    }
}

/**
 * @description Marks every interface row disconnected.
 *
 * Run once at boot. If EIS was killed, every client row still says connected
 * but the sockets are gone - clients will re-register within seconds, and
 * anything that does not was genuinely down.
 *
 * @returns {Promise<number>} How many rows were corrected
 */
async function resetAllConnectionStates() {

    const now = Date.now();

    const [ result ] = await pool.query(
        "UPDATE interface_configurations SET is_connected='0', updated_on=? "
        + "WHERE is_connected='1'",
        [ now ]
    );

    const [ pmsResult ] = await pool.query(
        "UPDATE property_pms SET is_connected='0', updated_on=? WHERE is_connected='1'",
        [ now ]
    );

    const total = result.affectedRows + pmsResult.affectedRows;

    if ( total > 0 ) {
        logger.warn( 'Reset ' + result.affectedRows + ' interface and '
                     + pmsResult.affectedRows + ' PMS rows left connected by a '
                     + 'previous run' );
    }

    return total;
}

/**
 * @description Records whether an ELC can currently reach a local endpoint.
 *
 * Lets the CMS distinguish "the hotel relay is up but the pfSense is down"
 * from a generic delivery failure, which is the difference between sending an
 * engineer to the hotel and restarting a service.
 *
 * @param {string} propertyId - Property
 * @param {string} endpointId - Endpoint business key
 * @param {boolean} reachable - Probe result
 * @param {string} detail - Free text detail for the history row
 * @returns {Promise<void>}
 */
async function updateEndpointReachability( propertyId, endpointId, reachable, detail ) {

    const now = Date.now();

    /* Read the current state first, so a history row is only written on a
       transition rather than on every probe */
    const [ rows ] = await pool.query(
        "SELECT is_connected FROM endpoints WHERE endpoint_id=? LIMIT 1",
        [ endpointId ]
    );

    if ( rows.length === 0 ) {
        return;
    }

    const wasConnected = Number( rows[ 0 ].is_connected ) === 1;

    if ( reachable ) {
        await pool.query(
            "UPDATE endpoints SET "
            + "    connection_begin_timestamp = IF( is_connected='1', "
            + "        connection_begin_timestamp, ? ), "
            + "    is_connected='1', last_communication_timestamp=? "
            + "WHERE endpoint_id=?",
            [ now, now, endpointId ]
        );
    }
    else {
        await pool.query(
            "UPDATE endpoints SET is_connected='0' WHERE endpoint_id=?",
            [ endpointId ]
        );
    }

    if ( wasConnected !== reachable ) {
        await recordHistory( propertyId, 'endpoint', endpointId,
                             reachable ? 'connected' : 'disconnected', detail );
    }
}

module.exports = {
    usePool: usePool,
    updateEndpointReachability: updateEndpointReachability,
    isAppLinkedToProperty: isAppLinkedToProperty,
    getInterfaceConfiguration: getInterfaceConfiguration,
    markInterfaceConnected: markInterfaceConnected,
    markInterfaceDisconnected: markInterfaceDisconnected,
    updatePmsLinkStatus: updatePmsLinkStatus,
    recordHeartbeat: recordHeartbeat,
    resetAllConnectionStates: resetAllConnectionStates,
    recordHistory: recordHistory,
    getPropertyPmsId: getPropertyPmsId
};
