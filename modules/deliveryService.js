/**
 * Delivers one queued guest event to a property endpoint.
 *
 * The queue stores its payload as JSON, but the NCS endpoints read flat
 * $_REQUEST fields, so the payload is expanded into individual form fields
 * here rather than posted as a blob. That keeps the NCS side conventional -
 * every other interface there reads flat fields too.
 */

'use strict';

const axios  = require( 'axios' );
const config = require( '../config/config' );
const logger = require( './logger' );
const auth   = require( './endpointAuth' );

/**
 * Maps a queue verb onto the what_do_you_want value the endpoint expects.
 * These are the generic NCS verbs, which interface.php then resolves to the
 * brand handler through the interfaces table.
 */
const VERB_MAP = {
    checkin:  'checkin',
    checkout: 'checkout',
    change:   'change'
};

/**
 * @description Parses the stored payload, tolerating an already-parsed object
 * @param {string|object} payload - Raw payload column value
 * @returns {object|null} Parsed payload, or null when unparseable
 */
function parsePayload( payload ) {

    if ( payload === null || payload === undefined ) {
        return null;
    }
    if ( typeof payload === 'object' ) {
        return payload;
    }

    try {
        return JSON.parse( payload );
    }
    catch ( err ) {
        return null;
    }
}

/**
 * @description Builds the form body for one delivery.
 *
 * Endpoints differ in how they want the guest attributes. An NCS box reads
 * flat $_REQUEST fields, one per attribute, while gen3 expects the whole
 * payload as a JSON string in a single data parameter. Keeping the choice on
 * the endpoint row means a new IPTV brand is a row, not a code change.
 *
 * @param {object} row - Queue row joined with its endpoint
 * @param {object} payload - Parsed payload
 * @returns {URLSearchParams} Form body ready to post
 */
function buildFormBody( row, payload ) {

    const form = new URLSearchParams();

    form.append( 'what_do_you_want', row.verb );

    /* Sent on every delivery, not just to endpoints that ask for it. A local
       NCS box serves one hotel and ignores it, but a cloud endpoint serves
       them all and cannot act without it. */
    form.append( 'property_id', row.property_id );

    if ( row.payload_format === 'json_data' ) {
        form.append( 'data', JSON.stringify( payload ) );
        return form;
    }

    Object.keys( payload ).forEach( function( key ) {

        const value = payload[ key ];

        if ( value === null || value === undefined ) {
            return;
        }
        if ( typeof value === 'object' ) {
            logger.debug( 'Skipping non-scalar payload field "' + key
                          + '" on queue row ' + row.id );
            return;
        }

        form.append( key, String( value ) );
    } );

    return form;
}

/**
 * @description Delivers one row to its endpoint.
 *
 * Distinguishes three outcomes so the queue can record which hop failed:
 * the endpoint was unreachable, the endpoint answered but rejected the
 * record, or it accepted.
 *
 * @param {object} row - Claimed queue row joined with its endpoint
 * @returns {Promise<object>} { success: boolean, stage: string, message: string }
 */
async function deliver( row ) {

    const payload = parsePayload( row.payload );

    if ( payload === null ) {
        /* Malformed JSON will never parse on a retry, so this is terminal */
        return {
            success: false,
            terminal: true,
            stage: 'endpoint_rejected',
            message: 'Queue payload is not valid JSON'
        };
    }

    const form = buildFormBody( row, payload );

    const headers = await auth.buildHeaders( row );

    if ( headers === null ) {
        return {
            success: false,
            stage: 'endpoint_rejected',
            message: 'Could not authenticate with this endpoint'
        };
    }

    logger.debug( 'Delivering queue row ' + row.id + ' (' + row.verb
                  + ' room ' + row.room_no + ') to ' + row.endpoint_url );

    let response;

    try {
        /* Full request dump, debug only. A delivery that fails at the endpoint is
            almost always a payload shape mismatch, and seeing the exact body sent
            is faster than inferring it from the endpoint's error message. */
         logger.debug( '--- DELIVERY REQUEST ---------------------------------' );
         logger.debug( 'Queue row   : ' + row.id + '  attempt ' + ( row.attempt_count + 1 ) );
         logger.debug( 'Endpoint    : ' + row.endpoint_id + ' (' + row.endpoint_type + ')' );
         logger.debug( 'URL         : ' + row.endpoint_url );
         logger.debug( 'Format      : ' + ( row.payload_format || 'flat' )
                       + ', auth ' + ( row.auth_type || 'none' ) );
         logger.debug( 'Headers     : ' + JSON.stringify( maskHeaders( headers ) ) );
         logger.debug( 'Body        : ' + form.toString() );

        response = await axios.post( row.endpoint_url, form.toString(), {
            timeout: config.delivery.timeout,
            headers: headers,
            // Treat any HTTP status as a response rather than throwing, so a
            // 500 from the endpoint is reported as a rejection rather than as
            // an unreachable host
            validateStatus: function() { return true; }
        } );
        
        
    }
    catch ( err ) {
        return {
            success: false,
            stage: 'endpoint_unreachable',
            message: err.code ? ( err.code + ' : ' + err.message ) : err.message
        };
    }
    
    logger.debug( '--- DELIVERY RESPONSE --------------------------------' );
    logger.debug( 'HTTP        : ' + response.status );
    logger.debug( 'Content-Type: ' + ( response.headers[ 'content-type' ] || 'unset' ) );
    logger.debug( 'Body        : ' + dumpBody( response.data ) );
    logger.debug( '------------------------------------------------------' );

    /* An expired token is recoverable. Clearing it means the retry in five
       minutes re-authenticates rather than failing the same way forever. */
    if ( response.status === 498 || response.status === 427 ) {
        auth.invalidate( row.endpoint_id );
        return {
            success: false,
            stage: 'endpoint_rejected',
            message: 'Token rejected by the endpoint, will re-authenticate on retry'
        };
    }

    return interpretResponse( response.data );
}

/**
 * @description Reads an NCS createJSONMessage response.
 *
 * NCS wraps its message in a single-element array, the same shape the Java
 * app had to unwrap. A response that is neither success nor error - most
 * often a PHP warning or fatal rendered as HTML - is treated as a failure,
 * because silently accepting it would lose the guest event.
 *
 * @param {*} data - Response body
 * @returns {object} { success, stage, message }
 */
function interpretResponse( data ) {

    let body = data;

    if ( typeof body === 'string' ) {
        try {
            body = JSON.parse( body );
        }
        catch ( err ) {
            return {
                success: false,
                stage: 'endpoint_rejected',
                message: 'Endpoint returned non-JSON : '
                         + String( data ).substring( 0, 200 )
            };
        }
    }

    if ( Array.isArray( body ) ) {
        body = body[ 0 ];
    }

    if ( !body || typeof body !== 'object' ) {
        return {
            success: false,
            stage: 'endpoint_rejected',
            message: 'Endpoint returned an unrecognised response'
        };
    }

    if ( body.type === 'success' ) {
        return {
            success: true,
            stage: 'none',
            message: typeof body.info === 'string' ? body.info : 'Delivered'
        };
    }

    return {
        success: false,
        stage: 'endpoint_rejected',
        message: typeof body.info === 'string'
                 ? body.info
                 : JSON.stringify( body.info || body ).substring( 0, 200 )
    };
}

/**
 * @description Delivers one row through the property's ELC.
 *
 * The endpoint sits on the hotel LAN and cannot be reached from this VPS, so
 * the work is pushed down the ELC's own outbound socket and the result comes
 * back as an ack. The return shape matches deliver(), so the queue processor
 * does not care which route was taken.
 *
 * @param {object} row - Claimed queue row joined with its endpoint
 * @param {object} wsServer - The WebSocket server module, injected to avoid
 *                            a require cycle between the two modules
 * @returns {Promise<object>} { success, stage, message }
 */
async function deliverViaElc( row, wsServer ) {

    const payload = parsePayload( row.payload );

    if ( payload === null ) {
        return {
            success: false,
            terminal: true,
            stage: 'endpoint_rejected',
            message: 'Queue payload is not valid JSON'
        };
    }

    logger.debug( 'Relaying queue row ' + row.id + ' (' + row.verb
                  + ' room ' + row.room_no + ') via the ELC at property '
                  + row.property_id );

    return wsServer.pushDelivery( row.property_id, row, payload );
}

/**
 * @description Masks credential values in a header set before logging.
 *
 * An access token in a log file is a credential sitting somewhere it was
 * never meant to be. The prefix is kept so a wrong or stale token is still
 * recognisable.
 *
 * @param {object} headers - Headers about to be sent
 * @returns {object} A copy safe to log
 */
function maskHeaders( headers ) {

    const safe = {};

    Object.keys( headers ).forEach( function( key ) {

        const value = String( headers[ key ] );

        if ( key.toLowerCase() === 'content-type' ) {
            safe[ key ] = value;
            return;
        }

        safe[ key ] = value.length > 12
                      ? ( value.substring( 0, 12 ) + '...[' + value.length + ' chars]' )
                      : '[set]';
    } );

    return safe;
}

/**
 * @description Renders a response body for logging, whatever type it arrived as.
 *
 * A PHP fatal or warning arrives as HTML rather than JSON, and that is
 * exactly the case worth seeing in full - so nothing is truncated below a
 * length that would hide it.
 *
 * @param {*} data - Response body
 * @returns {string}
 */
function dumpBody( data ) {

    if ( data === null || data === undefined ) {
        return '[empty]';
    }

    const text = ( typeof data === 'string' )
                 ? data
                 : JSON.stringify( data );

    return text.length > 4000
           ? ( text.substring( 0, 4000 ) + ' ...[truncated, ' + text.length + ' chars]' )
           : text;
}

module.exports = {
    deliver: deliver,
    deliverViaElc: deliverViaElc,
    interpretResponse: interpretResponse
};

