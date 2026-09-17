/**
 * Minimal level-aware logger.
 *
 * Deliberately not a dependency - PM2 already captures stdout to a file and
 * rotates it, so EIS only needs consistent formatting and a level filter.
 */

'use strict';

const config = require( '../config/config' );

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @description Returns the numeric threshold for the configured log level
 * @returns {number}
 */
function threshold() {
    return LEVELS[ config.logging.level ] || LEVELS.info;
}

/**
 * @description Writes one formatted log line
 * @param {string} level - debug | info | warn | error
 * @param {string} message - Text to log
 * @returns {void}
 */
function write( level, message ) {

    if ( LEVELS[ level ] < threshold() ) {
        return;
    }

    const stamp = new Date().toISOString().replace( 'T', ' ' ).substring( 0, 19 );
    console.log( stamp + ' [' + level.toUpperCase().padEnd( 5 ) + '] ' + message );
}

module.exports = {
    debug: function( m ) { write( 'debug', m ); },
    info:  function( m ) { write( 'info',  m ); },
    warn:  function( m ) { write( 'warn',  m ); },
    error: function( m ) { write( 'error', m ); }
};
