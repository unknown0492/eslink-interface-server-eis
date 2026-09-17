/**
 * Drains endpoint_delivery_queue.
 *
 * Normally woken by a trigger ping from eslink.online PHP the moment a row is
 * queued. The periodic sweep is a safety net for a lost ping and the clock
 * for retries that have become due.
 *
 * Two behaviours worth knowing:
 *
 *   Passes never overlap. A second trigger arriving mid-drain sets a flag
 *   rather than starting a concurrent pass, and the current pass repeats when
 *   it finishes. Overlapping passes would fight over the same rows and, worse,
 *   could deliver two events for one room out of order.
 *
 *   Deliveries to the same endpoint are paced. Each delivery to an NCS
 *   endpoint restarts RADIUS on that box, dropping every live guest session,
 *   so draining a backlog at full speed would repeatedly kick the whole hotel
 *   off the WiFi.
 */

'use strict';

const config       = require( '../config/config' );
const logger       = require( './logger' );
const database     = require( './database' );
const delivery     = require( './deliveryService' );
const wsServer     = require( './wsServer' );
const notification = require( './notificationService' );

let isDraining    = false;
let rerunRequested = false;
let sweepTimer    = null;

/** Last delivery time per endpoint, used for pacing */
const lastDeliveryAt = new Map();

const stats = {
    passes:    0,
    delivered: 0,
    failed:    0,
    expired:   0,
    startedAt: Date.now()
};

/**
 * @description Sleeps for a number of milliseconds
 * @param {number} ms - How long to wait
 * @returns {Promise<void>}
 */
function sleep( ms ) {
    return new Promise( function( resolve ) { setTimeout( resolve, ms ); } );
}

/**
 * @description Waits out the pacing interval for an endpoint, if needed
 * @param {string} endpointId - Endpoint about to receive a delivery
 * @returns {Promise<void>}
 */
async function pace( endpointId ) {

    const last = lastDeliveryAt.get( endpointId );

    if ( last ) {
        const elapsed = Date.now() - last;
        if ( elapsed < config.queue.endpointPacing ) {
            await sleep( config.queue.endpointPacing - elapsed );
        }
    }

    lastDeliveryAt.set( endpointId, Date.now() );
}

/**
 * @description Handles one claimed row end to end
 * @param {object} row - Claimed queue row joined with its endpoint
 * @returns {Promise<void>}
 */
async function processRow( row ) {

    /* The LEFT JOIN leaves these null when the endpoint no longer exists */
    if ( !row.endpoint_url ) {
        logger.warn( 'Queue row ' + row.id + ' references endpoint '
                     + row.endpoint_id + ' which has no URL or no longer exists' );
        await database.markEndpointUnusable( row.id,
            'Endpoint ' + row.endpoint_id + ' is missing or has no URL configured' );
        stats.failed++;
        return;
    }

    if ( Number( row.endpoint_enabled ) !== 1 || Number( row.endpoint_archived ) !== 0 ) {
        logger.warn( 'Queue row ' + row.id + ' targets a disabled or archived endpoint' );
        await database.markEndpointUnusable( row.id,
            'Endpoint ' + row.endpoint_id + ' is disabled or archived' );
        stats.failed++;
        return;
    }

    await pace( row.endpoint_id );

    /* Two routes, one result shape. A via_elc endpoint sits behind hotel NAT
       and is unreachable from this VPS, so the delivery is pushed down the
       ELC's own outbound socket instead. */
    let result;

    if ( row.delivery_mode === 'via_elc' ) {
        result = await delivery.deliverViaElc( row, wsServer );
    }
    else {
        result = await delivery.deliver( row );
    }

    if ( result.success ) {
        await database.markDelivered( row.id );
        stats.delivered++;
        logger.info( 'Delivered row ' + row.id + ' : ' + row.verb
                     + ' room ' + row.room_no + ' -> ' + result.message );
        await notification.reportRecovery( row );
        return;
    }

    /* A payload that will never parse is not worth retrying */
    if ( result.terminal ) {
        await database.markEndpointUnusable( row.id, result.message );
        stats.failed++;
        logger.error( 'Row ' + row.id + ' is permanently undeliverable : ' + result.message );
        return;
    }

    await database.markFailed( row.id, result.stage, result.message );
    stats.failed++;

    logger.warn( 'Row ' + row.id + ' failed (' + result.stage + ') : ' + result.message
                 + ' - retrying in ' + ( config.queue.retryDelay / 60000 ) + ' min' );

    await notification.reportFailure( row, result );
}

/**
 * @description Runs drain passes until the queue yields nothing more
 * @returns {Promise<void>}
 */
async function drain() {

    if ( isDraining ) {
        /* Remember that more work arrived, rather than running concurrently */
        rerunRequested = true;
        logger.debug( 'Drain already running, queued a rerun' );
        return;
    }

    isDraining = true;

    try {
        do {
            rerunRequested = false;

            for ( ;; ) {

                let rows;

                try {
                    rows = await database.claimBatch();
                }
                catch ( err ) {
                    logger.error( 'Failed to claim a batch : ' + err.message );
                    break;
                }

                if ( rows.length === 0 ) {
                    break;
                }

                stats.passes++;
                logger.debug( 'Claimed ' + rows.length + ' rows' );

                /* Sequential, not parallel. Per-room ordering is already
                   guaranteed by the claim query, but sequential delivery also
                   keeps the pacing honest and avoids hammering one endpoint. */
                for ( let i = 0; i < rows.length; i++ ) {
                    try {
                        await processRow( rows[ i ] );
                    }
                    catch ( err ) {
                        logger.error( 'Unexpected error on row ' + rows[ i ].id
                                      + ' : ' + err.message );
                        try {
                            await database.markFailed( rows[ i ].id,
                                'endpoint_unreachable', 'EIS error : ' + err.message );
                        }
                        catch ( inner ) {
                            logger.error( 'Could not even record the failure : '
                                          + inner.message );
                        }
                    }
                }

                /* A batch smaller than the limit means the queue is drained,
                   apart from rows blocked behind a pending retry */
                if ( rows.length < config.queue.batchSize ) {
                    break;
                }
            }
        }
        while ( rerunRequested );
    }
    finally {
        isDraining = false;
    }
}

/**
 * @description The periodic sweep - expires stale rows, then drains
 * @returns {Promise<void>}
 */
async function sweep() {

    try {
        const expired = await database.expireOldRows();

        if ( expired.length > 0 ) {
            stats.expired += expired.length;
            await notification.reportExpired( expired );
        }
    }
    catch ( err ) {
        logger.error( 'Expiry sweep failed : ' + err.message );
    }

    await drain();
}

/**
 * @description Starts the processor - reclaims orphaned rows, then begins
 *              the sweep timer and runs an immediate drain
 * @returns {Promise<void>}
 */
async function start() {

    await database.reclaimStaleInFlight();

    sweepTimer = setInterval( function() {
        sweep().catch( function( err ) {
            logger.error( 'Sweep threw : ' + err.message );
        } );
    }, config.queue.sweepInterval );

    logger.info( 'Queue processor started - sweep every '
                 + ( config.queue.sweepInterval / 1000 ) + 's, batch '
                 + config.queue.batchSize + ', pacing '
                 + config.queue.endpointPacing + 'ms per endpoint' );

    await sweep();
}

/**
 * @description Stops the sweep timer
 * @returns {void}
 */
function stop() {
    if ( sweepTimer ) {
        clearInterval( sweepTimer );
        sweepTimer = null;
    }
}

/**
 * @description Returns runtime counters for the health endpoint
 * @returns {object}
 */
function getStats() {
    return {
        passes:        stats.passes,
        delivered:     stats.delivered,
        failed:        stats.failed,
        expired:       stats.expired,
        isDraining:    isDraining,
        uptimeSeconds: Math.floor( ( Date.now() - stats.startedAt ) / 1000 )
    };
}

module.exports = {
    start: start,
    stop: stop,
    drain: drain,
    getStats: getStats
};
