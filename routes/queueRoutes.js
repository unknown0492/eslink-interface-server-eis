/**
 * HTTP surface for EIS.
 *
 * Only two endpoints, both intended for local use. The server binds to
 * 127.0.0.1 by default, so these are not reachable from outside the VPS.
 */

'use strict';

const express  = require( 'express' );
const logger   = require( '../modules/logger' );
const database = require( '../modules/database' );
const processor = require( '../modules/queueProcessor' );
const wsServer  = require( '../modules/wsServer' );

const router = express.Router();

/**
 * POST /api/queue/trigger
 *
 * Called by eslink.online PHP immediately after it queues a row.
 *
 * Responds before the drain starts, deliberately. PHP is holding an Apache
 * worker while it waits, and behind that the Java app is holding the PMS
 * waiting for its ACK - so this must return in milliseconds regardless of how
 * long the actual delivery takes.
 */
router.post( '/trigger', function( req, res ) {

    res.json( { success: true, message: 'Drain triggered' } );

    processor.drain().catch( function( err ) {
        logger.error( 'Triggered drain failed : ' + err.message );
    } );
} );

/**
 * GET /api/queue/status
 *
 * Queue depth plus runtime counters, for monitoring and for checking that a
 * deployment is alive.
 */
router.get( '/status', async function( req, res ) {

    try {
        const queue = await database.getQueueStats();

        res.json( {
            success: true,
            queue:   queue,
            runtime: processor.getStats(),
            clients: wsServer.listClients()
        } );
    }
    catch ( err ) {
        logger.error( 'Status query failed : ' + err.message );
        res.status( 500 ).json( { success: false, error: err.message } );
    }
} );

module.exports = router;
