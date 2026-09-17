/**
 * esLink Interface Server (EIS)
 * =============================================================================
 * Drains endpoint_delivery_queue and delivers guest events to each property's
 * configured endpoints.
 *
 * eslink.online PHP queues a row and pings this server, which claims the row,
 * posts it to the endpoint, and records the outcome. Nothing is delivered
 * from PHP itself - a request-scoped process cannot retry, and a slow endpoint
 * would hold an Apache worker open while the PMS waits for its ACK.
 *
 * Scope of this build: queue drain and delivery only. The WebSocket server for
 * the Java interface clients, live status writes and heartbeat monitoring are
 * separate work.
 */

'use strict';

require( 'dotenv' ).config();

const express = require( 'express' );

const config       = require( './config/config' );
const validate     = require( './config/config' ).validateConfig;
const logger       = require( './modules/logger' );
const database     = require( './modules/database' );
const processor    = require( './modules/queueProcessor' );
const statusRepo   = require( './modules/statusRepository' );
const wsServer     = require( './modules/wsServer' );
const queueRoutes  = require( './routes/queueRoutes' );
const commandRoutes= require( './routes/commandRoutes' );

class EIS {

    constructor() {
        this.app    = express();
        this.server = null;
    }

    /**
     * @description Installs middleware and routes
     * @returns {void}
     */
    setup() {

        this.app.use( express.json( { limit: '1mb' } ) );
        this.app.use( express.urlencoded( { extended: true, limit: '1mb' } ) );

        this.app.use( '/api/queue', queueRoutes );
        this.app.use( '/api/command', commandRoutes );

        this.app.get( '/health', function( req, res ) {
            res.json( { success: true, service: 'eis', uptime: process.uptime() } );
        } );

        this.app.use( function( req, res ) {
            res.status( 404 ).json( { success: false, error: 'Not found' } );
        } );

        this.app.use( function( err, req, res, next ) {
            logger.error( 'Unhandled request error : ' + err.message );
            res.status( 500 ).json( { success: false, error: 'Internal error' } );
        } );
    }

    /**
     * @description Validates config, connects to MySQL, starts the processor
     *              and begins listening
     * @returns {Promise<void>}
     */
    async start() {

        const errors = validate();

        if ( errors.length > 0 ) {
            errors.forEach( function( e ) { logger.error( 'Config : ' + e ); } );
            process.exit( 1 );
        }

        await database.init();

        /* Any row still marked connected belongs to a previous run whose
           sockets are gone. Clients re-register within seconds. */
        await statusRepo.resetAllConnectionStates();

        this.setup();

        this.server = this.app.listen( config.server.port, config.server.host, function() {
            logger.info( 'EIS listening on ' + config.server.host + ':' + config.server.port );
        } );

        wsServer.start();

        await processor.start();

        logger.info( 'EIS is ready' );
    }

    /**
     * @description Stops accepting work and closes resources cleanly.
     *
     * Rows left in_flight by an abrupt kill are recovered on the next boot by
     * reclaimStaleInFlight, so a hard stop loses nothing - it only delays
     * those rows until EIS comes back.
     *
     * @returns {Promise<void>}
     */
    async stop() {

        logger.info( 'Shutting down' );

        processor.stop();

        await wsServer.stop();

        if ( this.server ) {
            await new Promise( function( resolve ) {
                this.server.close( resolve );
            }.bind( this ) );
        }

        await database.close();

        logger.info( 'Shutdown complete' );
    }
}

const eis = new EIS();

eis.start().catch( function( err ) {
    logger.error( 'Failed to start : ' + err.message );
    logger.error( err.stack );
    process.exit( 1 );
} );

/* PM2 sends SIGINT on restart and SIGTERM on stop */
[ 'SIGINT', 'SIGTERM' ].forEach( function( signal ) {
    process.on( signal, function() {
        eis.stop()
            .then( function() { process.exit( 0 ); } )
            .catch( function() { process.exit( 1 ); } );
    } );
} );

process.on( 'unhandledRejection', function( reason ) {
    logger.error( 'Unhandled rejection : ' + reason );
} );

process.on( 'uncaughtException', function( err ) {
    logger.error( 'Uncaught exception : ' + err.message );
    logger.error( err.stack );
    process.exit( 1 );
} );
