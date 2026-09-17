/**
 * PM2 process definition for EIS.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
    apps: [ {
        name:   'eis',
        script: 'eis.js',
        cwd:    __dirname,

        instances:  1,
        exec_mode:  'fork',

        autorestart: true,
        watch:       false,

        // A restart loop means the config is wrong; back off rather than
        // hammering MySQL with reconnection attempts
        max_restarts:        10,
        min_uptime:          '30s',
        restart_delay:       5000,
        exp_backoff_restart_delay: 2000,

        max_memory_restart: '300M',

        env: {
            NODE_ENV: 'production'
        },

        error_file: './logs/eis-error.log',
        out_file:   './logs/eis-out.log',
        merge_logs: true,
        time:       false        // The logger already writes its own timestamps
    } ]
};
