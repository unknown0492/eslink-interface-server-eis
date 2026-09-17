/**
 * Command relay.
 *
 * eslink.online PHP calls these to push an action down to an on-site client.
 * They are on the loopback-bound HTTP listener, not the public WebSocket
 * port, so only something running on this VPS can issue a command.
 *
 * Commands are never queued for an offline client - see pushCommand() for
 * why. A caller gets a clear "not connected" rather than a promise that may
 * be fulfilled hours later.
 */

'use strict';

const express  = require( 'express' );
const logger   = require( '../modules/logger' );
const wsServer = require( '../modules/wsServer' );

const router = express.Router();

/** Actions a caller is allowed to push. Anything else is rejected. */
const ALLOWED_ACTIONS = [ 'restart', 'datasync', 'refresh_config' ];

/**
 * POST /api/command/push
 *
 * Body: property_id, action, client_type (optional), params (optional object)
 */
router.post( '/push', function( req, res ) {

    const propertyId = String( req.body.property_id || '' );
    const action     = String( req.body.action || '' );
    const clientType = String( req.body.client_type || 'esgate_interface' );

    if ( !propertyId || !action ) {
        return res.status( 400 ).json( {
            success: false,
            error: 'property_id and action are both required'
        } );
    }

    if ( ALLOWED_ACTIONS.indexOf( action ) === -1 ) {
        return res.status( 400 ).json( {
            success: false,
            error: 'Unrecognised action. Allowed : ' + ALLOWED_ACTIONS.join( ', ' )
        } );
    }

    let params = req.body.params || {};

    if ( typeof params === 'string' ) {
        try { params = JSON.parse( params ); }
        catch ( err ) { params = {}; }
    }

    const result = wsServer.pushCommand( propertyId, clientType, action, params );

    if ( !result.success ) {
        logger.warn( 'Could not push ' + action + ' to property ' + propertyId
                     + ' : ' + result.reason );
        return res.status( 409 ).json( { success: false, error: result.reason } );
    }

    res.json( {
        success: true,
        command_id: result.command_id,
        message: action + ' pushed to ' + clientType + ' at property ' + propertyId
    } );
} );

/**
 * GET /api/command/clients
 *
 * Which on-site clients are connected right now.
 */
router.get( '/clients', function( req, res ) {
    res.json( { success: true, clients: wsServer.listClients() } );
} );

module.exports = router;
