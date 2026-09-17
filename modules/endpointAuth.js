/**
 * Per-endpoint authentication.
 *
 * Endpoints differ: a pfSense on the hotel LAN takes an unauthenticated POST,
 * while gen3 expects an app token. Rather than special casing each one in the
 * delivery path, the credentials live on the endpoint row and this module
 * turns them into a header.
 *
 * Tokens are cached in memory per endpoint. A restart loses them, which costs
 * one extra authentication call - cheaper than persisting a credential.
 */

'use strict';

const axios  = require( 'axios' );
const config = require( '../config/config' );
const logger = require( './logger' );

/** Cached tokens keyed by endpoint_id */
const tokens = new Map();

/** Re-authenticate this long before nominal expiry, to avoid a race */
const REFRESH_MARGIN_MS = 300000;

/** Assumed lifetime, since the API does not report one */
const ASSUMED_LIFETIME_MS = 3600000;

/**
 * @description Clears a cached token, forcing the next call to re-authenticate
 * @param {string} endpointId - Endpoint whose token is no longer valid
 * @returns {void}
 */
function invalidate( endpointId ) {
    tokens.delete( endpointId );
}

/**
 * @description Exchanges an endpoint's app credentials for an access token
 * @param {object} row - Queue row joined with its endpoint
 * @returns {Promise<string|null>} The token, or null when authentication failed
 */
async function authenticate( row ) {

    const authUrl = row.auth_url && row.auth_url !== ''
                    ? row.auth_url
                    : row.endpoint_url;

    try {
        const form = new URLSearchParams();
        form.append( 'what_do_you_want', 'scodezy_authenticate_app' );
        form.append( 'app_id', row.auth_app_id );
        form.append( 'app_secret', row.auth_app_secret );

        const response = await axios.post( authUrl, form.toString(), {
            timeout: config.delivery.timeout,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            validateStatus: function() { return true; }
        } );

        let body = response.data;

        if ( typeof body === 'string' ) {
            body = JSON.parse( body );
        }
        if ( Array.isArray( body ) ) {
            body = body[ 0 ];
        }

        if ( !body || body.type !== 'success' || !body.info || !body.info.access_token ) {
            logger.warn( 'Authentication rejected by endpoint ' + row.endpoint_id
                         + ' : ' + JSON.stringify( body ).substring( 0, 200 ) );
            return null;
        }

        tokens.set( row.endpoint_id, {
            token:    body.info.access_token,
            expiryAt: Date.now() + ASSUMED_LIFETIME_MS
        } );

        logger.info( 'Authenticated with endpoint ' + row.endpoint_id
                     + ' as app ' + row.auth_app_id );

        return body.info.access_token;
    }
    catch ( err ) {
        logger.warn( 'Could not authenticate with endpoint ' + row.endpoint_id
                     + ' : ' + err.message );
        return null;
    }
}

/**
 * @description Returns the headers a delivery to this endpoint needs.
 *
 * An endpoint with auth_type 'none' gets only the content type, which is the
 * case for every NCS endpoint on a hotel LAN.
 *
 * @param {object} row - Queue row joined with its endpoint
 * @returns {Promise<object|null>} Headers, or null when authentication failed
 */
async function buildHeaders( row ) {

    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

    if ( row.auth_type !== 'app_token' ) {
        return headers;
    }

    if ( !row.auth_app_id || !row.auth_app_secret ) {
        logger.warn( 'Endpoint ' + row.endpoint_id
                     + ' requires a token but has no credentials configured' );
        return null;
    }

    const cached = tokens.get( row.endpoint_id );
    let   token  = null;

    if ( cached && Date.now() < ( cached.expiryAt - REFRESH_MARGIN_MS ) ) {
        token = cached.token;
    }
    else {
        token = await authenticate( row );
    }

    if ( !token ) {
        return null;
    }

    headers[ row.auth_header_name || 'xAwBo5Re9a' ] = token;

    return headers;
}

module.exports = {
    buildHeaders: buildHeaders,
    invalidate: invalidate
};