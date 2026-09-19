#!/usr/bin/env node

/**
 * Cleanup CVE Fix Script
 *
 * Adapter 2.x and older added `--security-revert=CVE-2023-46809` to `common.nodeProcessParams` of
 * every instance running on node.js 18 or 20, to keep livestreaming working. node.js 22 and newer
 * refuse to start a process with that flag, and since the instance never starts, the adapter cannot
 * remove it itself. This script runs on every install and removes the flag from all eusec instances.
 * Other node process parameters are kept.
 *
 * Usage: node cleanupCveFix.js
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CVE_FLAG = '--security-revert=CVE-2023-46809';
const CONTROLLER_CLI = path.join('..', 'iobroker.js-controller', 'iobroker.js');

/**
 * Log a message with timestamp
 *
 * @param {string} message - The message to log
 */
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Run an ioBroker CLI command and return its output
 *
 * @param {...string} args - The CLI arguments
 * @returns {string} The command output
 */
function iobroker(...args) {
    return execFileSync(process.execPath, [CONTROLLER_CLI, ...args], { encoding: 'utf-8' }).trim();
}

/**
 * Remove the CVE flag from a list of node process parameters
 *
 * @param {unknown} params - The value of common.nodeProcessParams
 * @returns {string[] | null} The parameters without the flag, or null if there is nothing to remove
 */
function withoutCveFlag(params) {
    if (!Array.isArray(params) || !params.includes(CVE_FLAG)) {
        return null;
    }
    return params.filter(param => param !== CVE_FLAG);
}

/**
 * Get list of eusec adapter instances
 *
 * @returns {number[]} Array of instance numbers
 */
function getEusecInstances() {
    log('Retrieving eusec adapter instances...');

    try {
        const output = iobroker('object', 'list', 'system.adapter.eusec.*');
        const matches = output.matchAll(/system\.adapter\.eusec\.(\d+)/g);
        const instances = [...new Set(Array.from(matches, match => parseInt(match[1], 10)))];

        log(`Found ${instances.length} eusec instance(s): ${instances.join(', ')}`);
        return instances;
    } catch (error) {
        log(`No eusec instances found or error occurred while listing instances: ${String(error)}`);
        return [];
    }
}

/**
 * Remove the CVE flag from the node process parameters of one instance
 *
 * @param {number} instanceNumber - The instance number to fix
 */
function fixInstance(instanceNumber) {
    const objectId = `system.adapter.eusec.${instanceNumber}`;
    const instance = JSON.parse(iobroker('object', 'get', objectId));
    const params = withoutCveFlag(instance?.common?.nodeProcessParams);

    if (params === null) {
        log(`Instance ${instanceNumber} does not carry ${CVE_FLAG} - nothing to do`);
        return;
    }
    iobroker('object', 'set', objectId, `common.nodeProcessParams=${JSON.stringify(params)}`);
    log(`Removed ${CVE_FLAG} from instance ${instanceNumber}`);
}

/**
 * Main function
 */
function main() {
    log('=== Cleanup CVE Fix Script Started ===');

    const instances = getEusecInstances();
    let failCount = 0;

    for (const instanceNumber of instances) {
        try {
            fixInstance(instanceNumber);
        } catch (error) {
            // Not fatal: a failing postinstall would abort the whole adapter installation.
            log(`Failed to fix instance ${instanceNumber}: ${String(error)}`);
            log(
                `If the instance does not start, remove ${CVE_FLAG} by hand: ` +
                    `iobroker object set system.adapter.eusec.${instanceNumber} common.nodeProcessParams=[]`,
            );
            failCount++;
        }
    }

    log(`=== Cleanup CVE Fix Script Completed with ${failCount} failure(s) ===`);
}

// Run the main function
if (require.main === module) {
    main();
}

module.exports = { withoutCveFlag, getEusecInstances, fixInstance };
