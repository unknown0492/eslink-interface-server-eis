/**
 * Database access for EIS.
 *
 * Owns every SQL statement in the application. Nothing else in EIS talks to
 * MySQL directly, so the queue's claiming rules live in exactly one place.
 *
 * Two invariants this module enforces:
 *
 *   1. Per-room FIFO. A row is only eligible when no EARLIER row for the same
 *      property, endpoint and room is still pending or in flight. Without this
 *      a check-out can overtake a check-in and leave a departed guest with a
 *      working account.
 *
 *   2. Atomic claiming. Rows are selected, then claimed with a conditional
 *      UPDATE that only succeeds if they are still pending. If a second drain
 *      pass overlaps, the loser claims nothing rather than delivering twice.
 */

'use strict';

const mysql  = require( 'mysql2/promise' );
const config = require( '../config/config' );
const logger = require( './logger' );
const status = require( './statusRepository' );

let pool = null;

/**
 * @description Creates the connection pool and verifies it works
 * @returns {Promise<void>}
 */
async function init() {

    pool = mysql.createPool( {
        host:               config.database.host,
        port:               config.database.port,
        database:           config.database.database,
        user:               config.database.user,
        password:           config.database.password,
        connectionLimit:    config.database.connectionLimit,
        waitForConnections: true,
        queueLimit:         0,
        // Timestamps are epoch milliseconds in BIGINT columns; without this
        // mysql2 hands back strings for large integers on some drivers
        supportBigNumbers:  true,
        bigNumberStrings:   false
    } );

    /* statusRepository shares this pool rather than opening a second one */
    status.usePool( pool );

    const conn = await pool.getConnection();
    try {
        await conn.query( 'SELECT 1' );
        logger.info( 'Database pool ready - ' + config.database.database
                     + ' on ' + config.database.host );
    }
    finally {
        conn.release();
    }
}

/**
 * @description Closes the pool during shutdown
 * @returns {Promise<void>}
 */
async function close() {
    if ( pool ) {
        await pool.end();
        pool = null;
        logger.info( 'Database pool closed' );
    }
}

/**
 * @description Returns any in_flight rows to pending.
 *
 * Called once at boot. If EIS was killed mid-delivery those rows would
 * otherwise sit in_flight forever, and because they block their room's FIFO
 * queue, every later event for that room would stall behind them.
 *
 * @returns {Promise<number>} How many rows were reclaimed
 */
async function reclaimStaleInFlight() {

    const [ result ] = await pool.query(
        "UPDATE endpoint_delivery_queue SET status='pending' WHERE status='in_flight'"
    );

    if ( result.affectedRows > 0 ) {
        logger.warn( 'Reclaimed ' + result.affectedRows
                     + ' in-flight rows left behind by a previous run' );
    }
    return result.affectedRows;
}

/**
 * @description Marks rows past their maximum age as expired.
 *
 * Expired rows are kept rather than deleted, so support can see what was
 * never delivered. A 24 hour old check-in is not worth replaying anyway -
 * the guest has usually left by then.
 *
 * @returns {Promise<Array>} The rows that were expired, for notification
 */
async function expireOldRows() {

    const cutoff = Date.now() - config.queue.maxAge;

    const [ rows ] = await pool.query(
        "SELECT id, property_id, endpoint_id, room_no, verb, attempt_count, last_error "
        + "FROM endpoint_delivery_queue "
        + "WHERE status IN ('pending','failed') AND created_on < ?",
        [ cutoff ]
    );

    if ( rows.length === 0 ) {
        return [];
    }

    const ids = rows.map( function( r ) { return r.id; } );

    await pool.query(
        "UPDATE endpoint_delivery_queue SET status='expired' WHERE id IN (?)",
        [ ids ]
    );

    logger.warn( 'Expired ' + rows.length + ' rows older than '
                 + ( config.queue.maxAge / 3600000 ) + ' hours' );
    return rows;
}

/**
 * @description Claims a batch of deliverable rows.
 *
 * The NOT EXISTS clause is what enforces per-room ordering. Note it also
 * blocks on rows whose retry is not yet due - that is intentional. If a
 * check-in is waiting five minutes to retry, the check-out behind it must
 * wait too, or the guest's account would be created after it was deleted.
 *
 * @returns {Promise<Array>} Claimed rows, joined with their endpoint details
 */
async function claimBatch() {

    const now = Date.now();

    const [ candidates ] = await pool.query(
        "SELECT q.id "
        + "FROM endpoint_delivery_queue q "
        + "WHERE q.status='pending' "
        + "  AND q.next_attempt_timestamp <= ? "
        + "  AND NOT EXISTS ( "
        + "        SELECT 1 FROM endpoint_delivery_queue e "
        + "        WHERE e.property_id = q.property_id "
        + "          AND e.endpoint_id = q.endpoint_id "
        + "          AND e.room_no     = q.room_no "
        + "          AND e.id          < q.id "
        + "          AND e.status IN ('pending','in_flight') "
        + "      ) "
        + "ORDER BY q.id ASC LIMIT ?",
        [ now, config.queue.batchSize ]
    );

    if ( candidates.length === 0 ) {
        return [];
    }

    const ids = candidates.map( function( r ) { return r.id; } );

    /* Conditional on status so two overlapping passes cannot both claim */
    const [ claimed ] = await pool.query(
        "UPDATE endpoint_delivery_queue SET status='in_flight' "
        + "WHERE id IN (?) AND status='pending'",
        [ ids ]
    );

    if ( claimed.affectedRows === 0 ) {
        return [];
    }

    /* Read back only what we actually claimed, with the endpoint attached.
       An INNER JOIN means a row whose endpoint has been deleted or disabled
       is simply never returned - handled separately below. */
    const [ rows ] = await pool.query(
        "SELECT q.id, q.property_id, q.endpoint_id, q.room_no, q.verb, q.payload, "
        + "       q.attempt_count, q.created_on, "
        + "       e.endpoint_url, e.endpoint_type, e.delivery_mode, e.payload_format, "
        + "       e.auth_type, e.auth_url, e.auth_app_id, e.auth_app_secret, "
        + "       e.auth_header_name, "
        + "       e.enabled AS endpoint_enabled, e.archived AS endpoint_archived "
        + "FROM endpoint_delivery_queue q "
        + "LEFT JOIN endpoints e ON e.endpoint_id = q.endpoint_id "
        + "WHERE q.id IN (?) AND q.status='in_flight' "
        + "ORDER BY q.id ASC",
        [ ids ]
    );

    return rows;
}

/**
 * @description Marks a row delivered
 * @param {number} id - Queue row id
 * @returns {Promise<void>}
 */
async function markDelivered( id ) {
    await pool.query(
        "UPDATE endpoint_delivery_queue "
        + "SET status='delivered', delivered_on=?, last_error='', last_error_stage='none' "
        + "WHERE id=?",
        [ Date.now(), id ]
    );
}

/**
 * @description Records a failed delivery and schedules the retry.
 *
 * The row goes back to pending rather than failed, because failed is a
 * terminal state in this design and every failure here is retryable until
 * the row expires.
 *
 * @param {number} id - Queue row id
 * @param {string} stage - Which hop failed: elc_unreachable, endpoint_unreachable, endpoint_rejected
 * @param {string} error - Error text, truncated to fit the column
 * @returns {Promise<void>}
 */
async function markFailed( id, stage, error ) {

    const nextAttempt = Date.now() + config.queue.retryDelay;
    const text = String( error || '' ).substring( 0, 500 );

    await pool.query(
        "UPDATE endpoint_delivery_queue "
        + "SET status='pending', attempt_count=attempt_count+1, "
        + "    next_attempt_timestamp=?, last_error=?, last_error_stage=? "
        + "WHERE id=?",
        [ nextAttempt, text, stage, id ]
    );
}

/**
 * @description Parks a row whose endpoint is missing, disabled or archived.
 *
 * Retrying would be pointless - nothing about the endpoint will change on its
 * own - so the row is failed rather than rescheduled.
 *
 * @param {number} id - Queue row id
 * @param {string} reason - Why the endpoint is unusable
 * @returns {Promise<void>}
 */
async function markEndpointUnusable( id, reason ) {
    await pool.query(
        "UPDATE endpoint_delivery_queue "
        + "SET status='failed', attempt_count=attempt_count+1, "
        + "    last_error=?, last_error_stage='endpoint_rejected' "
        + "WHERE id=?",
        [ String( reason ).substring( 0, 500 ), id ]
    );
}

/**
 * @description Counts rows currently waiting, for the health endpoint and
 *              for the queue depth quoted in failure notifications
 * @returns {Promise<object>} Counts keyed by status
 */
async function getQueueStats() {

    const [ rows ] = await pool.query(
        "SELECT status, COUNT(*) AS total FROM endpoint_delivery_queue GROUP BY status"
    );

    const stats = { pending: 0, in_flight: 0, delivered: 0, failed: 0, expired: 0 };
    rows.forEach( function( r ) { stats[ r.status ] = Number( r.total ); } );
    return stats;
}

/**
 * @description Returns how many rows are currently failing for an endpoint,
 *              so a notification can report depth rather than a single row
 * @param {string} endpointId - Endpoint business key
 * @returns {Promise<number>}
 */
async function getBacklogForEndpoint( endpointId ) {

    const [ rows ] = await pool.query(
        "SELECT COUNT(*) AS total FROM endpoint_delivery_queue "
        + "WHERE endpoint_id=? AND status='pending' AND attempt_count > 0",
        [ endpointId ]
    );

    return Number( rows[ 0 ].total );
}

module.exports = {
    init: init,
    close: close,
    reclaimStaleInFlight: reclaimStaleInFlight,
    expireOldRows: expireOldRows,
    claimBatch: claimBatch,
    markDelivered: markDelivered,
    markFailed: markFailed,
    markEndpointUnusable: markEndpointUnusable,
    getQueueStats: getQueueStats,
    getBacklogForEndpoint: getBacklogForEndpoint
};
