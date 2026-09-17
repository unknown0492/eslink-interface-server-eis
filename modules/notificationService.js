/**
 * Failure notifications.
 *
 * EIS never sends SMTP itself - it asks eslink.online to do it, so mail
 * credentials and the PHPMailer configuration stay in one place.
 *
 * The state machine matters more than the transport here. A dead endpoint
 * with forty queued guests would otherwise produce forty emails per retry
 * cycle. Instead support gets one email when an endpoint starts failing,
 * one every fifteen minutes while it stays down, and one when it recovers -
 * each quoting the current backlog rather than a single row.
 */

'use strict';

const axios    = require( 'axios' );
const config   = require( '../config/config' );
const logger   = require( './logger' );
const database = require( './database' );

/** Per-endpoint alert state, keyed by endpoint_id */
const alertState = new Map();

/** Cached access token for calls back into eslink.online */
let accessToken       = '';
let tokenExpiryMillis = 0;

/**
 * @description Obtains an app token from eslink.online, reusing the cached
 *              one until it is close to expiry
 * @returns {Promise<string>} Access token, or empty string on failure
 */
async function ensureValidToken() {

    if ( accessToken && Date.now() < ( tokenExpiryMillis - 300000 ) ) {
        return accessToken;
    }

    try {
        const form = new URLSearchParams();
        form.append( 'what_do_you_want', 'scodezy_authenticate_app' );
        form.append( 'app_id', config.auth.appId );
        form.append( 'app_secret', config.auth.appSecret );

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

        if ( !body || body.type !== 'success' ) {
            logger.warn( 'Could not authenticate with eslink.online for notifications' );
            return '';
        }

        accessToken = body.info.access_token;
        // The API does not report an expiry, so assume an hour and let a
        // rejected call force re-authentication
        tokenExpiryMillis = Date.now() + 3600000;

        return accessToken;
    }
    catch ( err ) {
        logger.warn( 'Authentication for notifications failed : ' + err.message );
        return '';
    }
}

/**
 * @description Asks eslink.online to email the property's support contacts
 * @param {string} propertyId - Property the alert concerns
 * @param {string} notificationType - Routes to the right recipients
 * @param {string} subject - Email subject
 * @param {string} message - Email body
 * @returns {Promise<boolean>} True when eslink.online accepted the request
 */
async function sendNotification( propertyId, notificationType, subject, message ) {

    if ( !config.notify.enabled ) {
        logger.debug( 'Notifications disabled, not sending : ' + subject );
        return false;
    }

    const token = await ensureValidToken();
    if ( !token ) {
        return false;
    }

    try {
        const form = new URLSearchParams();
        form.append( 'what_do_you_want', 'eslink_send_notification_email' );
        form.append( 'property_id', propertyId );
        form.append( 'app_id', config.auth.appId );
        form.append( 'notification_type', notificationType );
        form.append( 'subject', subject );
        form.append( 'message', message );

        const response = await axios.post( config.eslinkApi.url, form.toString(), {
            timeout: config.eslinkApi.timeout,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'xAwBo5Re9a': token
            }
        } );

        let body = response.data;
        if ( typeof body === 'string' ) {
            body = JSON.parse( body );
        }
        if ( Array.isArray( body ) ) {
            body = body[ 0 ];
        }

        if ( body && body.type === 'success' ) {
            logger.info( 'Notification sent : ' + subject );
            return true;
        }

        logger.warn( 'eslink.online rejected the notification : '
                     + JSON.stringify( body ).substring( 0, 200 ) );
        return false;
    }
    catch ( err ) {
        logger.warn( 'Failed to send notification : ' + err.message );
        return false;
    }
}

/**
 * @description Records a delivery failure and emails support when the alert
 *              state machine says it is due
 * @param {object} row - The queue row that failed
 * @param {object} result - Delivery result, carrying stage and message
 * @returns {Promise<void>}
 */
async function reportFailure( row, result ) {

    const key   = row.endpoint_id;
    const now   = Date.now();
    const state = alertState.get( key ) || { failing: false, lastAlert: 0 };

    const isFirstFailure = !state.failing;
    const isRepeatDue    = state.failing
                           && ( now - state.lastAlert ) >= config.notify.repeatInterval;

    state.failing = true;
    alertState.set( key, state );

    if ( !isFirstFailure && !isRepeatDue ) {
        return;
    }

    const backlog = await database.getBacklogForEndpoint( row.endpoint_id );

    const stageText = {
        endpoint_unreachable: 'The endpoint could not be reached',
        endpoint_rejected:    'The endpoint rejected the record',
        elc_unreachable:      'The on-site ELC could not be reached'
    }[ result.stage ] || 'Delivery failed';

    const subject = isFirstFailure
                    ? 'Endpoint delivery failing at property ' + row.property_id
                    : 'Endpoint delivery still failing at property ' + row.property_id;

    const message =
        stageText + '.<br /><br />'
        + 'Property : ' + row.property_id + '<br />'
        + 'Endpoint : ' + row.endpoint_id + ' (' + ( row.endpoint_type || 'unknown' ) + ')<br />'
        + 'URL : ' + ( row.endpoint_url || 'not configured' ) + '<br />'
        + 'Last event : ' + row.verb + ' for room ' + row.room_no + '<br />'
        + 'Attempts on this record : ' + ( row.attempt_count + 1 ) + '<br />'
        + 'Records waiting to deliver : ' + backlog + '<br /><br />'
        + 'Error : ' + result.message;

    state.lastAlert = now;
    alertState.set( key, state );

    await sendNotification( row.property_id, 'endpoint_down', subject, message );
}

/**
 * @description Clears the failing state for an endpoint and emails a recovery
 *              notice if it had previously alerted
 * @param {object} row - A row that delivered successfully
 * @returns {Promise<void>}
 */
async function reportRecovery( row ) {

    const state = alertState.get( row.endpoint_id );

    if ( !state || !state.failing ) {
        return;
    }

    alertState.set( row.endpoint_id, { failing: false, lastAlert: 0 } );

    const subject = 'Endpoint delivery recovered at property ' + row.property_id;
    const message =
        'Deliveries to this endpoint are succeeding again.<br /><br />'
        + 'Property : ' + row.property_id + '<br />'
        + 'Endpoint : ' + row.endpoint_id + '<br />'
        + 'URL : ' + ( row.endpoint_url || '' ) + '<br /><br />'
        + 'Any records queued while it was down are being delivered in order.';

    await sendNotification( row.property_id, 'endpoint_down', subject, message );
}

/**
 * @description Emails a summary when records are abandoned at the age cap
 * @param {Array} rows - The rows that expired
 * @returns {Promise<void>}
 */
async function reportExpired( rows ) {

    if ( rows.length === 0 ) {
        return;
    }

    /* One email per property rather than per row */
    const byProperty = new Map();

    rows.forEach( function( r ) {
        if ( !byProperty.has( r.property_id ) ) {
            byProperty.set( r.property_id, [] );
        }
        byProperty.get( r.property_id ).push( r );
    } );

    for ( const [ propertyId, propertyRows ] of byProperty ) {

        let detail = '';
        propertyRows.slice( 0, 20 ).forEach( function( r ) {
            detail += r.verb + ' for room ' + r.room_no
                      + ' after ' + r.attempt_count + ' attempts'
                      + ' - ' + ( r.last_error || 'no error recorded' ) + '<br />';
        } );

        if ( propertyRows.length > 20 ) {
            detail += '... and ' + ( propertyRows.length - 20 ) + ' more<br />';
        }

        const message =
            propertyRows.length + ' guest record(s) were abandoned after '
            + ( config.queue.maxAge / 3600000 ) + ' hours without a successful '
            + 'delivery.<br /><br />'
            + 'These are no longer being retried. The affected rooms may have '
            + 'stale WiFi or IPTV access.<br /><br />'
            + detail;

        await sendNotification(
            propertyId,
            'queue_failure',
            'Undelivered guest records abandoned at property ' + propertyId,
            message
        );
    }
}

module.exports = {
    sendNotification: sendNotification,
    reportFailure: reportFailure,
    reportRecovery: reportRecovery,
    reportExpired: reportExpired
};
