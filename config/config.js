/**
 * EIS configuration
 *
 * Every value is overridable from .env. Defaults are chosen to be safe on a
 * shared VPS rather than fast - in particular the batch size and endpoint
 * pacing are deliberately conservative, because each delivery to an NCS
 * endpoint restarts RADIUS on that box and drops live guest sessions.
 */

'use strict';

const path = require( 'path' );

const config = {

    server: {
        port: parseInt( process.env.PORT ) || 3222,
        // Loopback by default - the trigger endpoint must not be reachable
        // from outside this VPS
        host: process.env.HOST || '127.0.0.1'
    },

    auth: {
        appId:     process.env.APP_ID || '',
        appSecret: process.env.APP_SECRET || ''
    },

    eslinkApi: {
        url:     process.env.ESLINK_API_URL || 'https://eslink.online/interface-client-api.php',
        timeout: parseInt( process.env.ESLINK_API_TIMEOUT ) || 30000
    },

    database: {
        host:            process.env.DB_HOST || 'localhost',
        port:            parseInt( process.env.DB_PORT ) || 3306,
        database:        process.env.DB_NAME || '',
        user:            process.env.DB_USER || '',
        password:        process.env.DB_PASSWORD || '',
        connectionLimit: parseInt( process.env.DB_CONNECTION_LIMIT ) || 5,
        waitForConnections: true,
        queueLimit: 0
    },

    ws: {
        // Public, unlike the HTTP trigger endpoint - hotel interface PCs
        // connect here from the internet
        host: process.env.WS_HOST || '0.0.0.0',
        port: parseInt( process.env.WS_PORT ) || 3223,

        // How often EIS pings each client to prove the socket is still live.
        // A TCP connection can stay open long after the peer has vanished.
        pingInterval: parseInt( process.env.WS_PING_INTERVAL ) || 30000,

        // A socket that never authenticates is closed after this
        helloTimeout: parseInt( process.env.WS_HELLO_TIMEOUT ) || 15000,

        // Advertised to clients in hello_ack so they all use one cadence
        expectedHeartbeatInterval:
            parseInt( process.env.WS_HEARTBEAT_INTERVAL ) || 300000,

        commandAckTimeout: parseInt( process.env.WS_COMMAND_ACK_TIMEOUT ) || 60000,

        // How long EIS waits for an ELC to acknowledge a pushed delivery.
        // Must exceed a restart_radius() round trip, but stay short enough
        // that a dead ELC does not stall that room's FIFO for minutes.
        deliveryAckTimeout: parseInt( process.env.WS_DELIVERY_ACK_TIMEOUT ) || 30000
    },

    queue: {
        // Safety net for a lost trigger ping, and the clock for due retries
        sweepInterval:  parseInt( process.env.QUEUE_SWEEP_INTERVAL ) || 60000,
        batchSize:      parseInt( process.env.QUEUE_BATCH_SIZE ) || 20,
        endpointPacing: parseInt( process.env.QUEUE_ENDPOINT_PACING ) || 1500,
        retryDelay:     parseInt( process.env.QUEUE_RETRY_DELAY ) || 300000,
        maxAge:         parseInt( process.env.QUEUE_MAX_AGE ) || 86400000
    },

    delivery: {
        timeout: parseInt( process.env.DELIVERY_TIMEOUT ) || 20000
    },

    notify: {
        enabled:        process.env.NOTIFY_ENABLED !== 'false',
        repeatInterval: parseInt( process.env.NOTIFY_REPEAT_INTERVAL ) || 900000
    },

    logging: {
        level: process.env.LOG_LEVEL || 'info'
    },

    environment:  process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',

    paths: {
        root: path.resolve( __dirname, '..' ),
        logs: path.resolve( __dirname, '..', 'logs' )
    }
};

/**
 * Validates configuration that EIS cannot start without.
 *
 * @returns {string[]} List of problems, empty when the config is usable
 */
function validateConfig() {

    const errors = [];

    if ( !config.database.database ) {
        errors.push( 'DB_NAME is required - set it in .env' );
    }
    if ( !config.database.user ) {
        errors.push( 'DB_USER is required - set it in .env' );
    }
    if ( !config.auth.appId ) {
        errors.push( 'APP_ID is required - set it in .env' );
    }
    if ( config.notify.enabled && !config.auth.appSecret ) {
        errors.push( 'APP_SECRET is required when NOTIFY_ENABLED is true' );
    }

    return errors;
}

module.exports = config;
module.exports.validateConfig = validateConfig;
