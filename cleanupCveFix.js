#!/usr/bin/env node

/**
 * Cleanup CVE Fix Script
 *
 * This script fixes a security issue by clearing nodeProcessParams for eusec adapter instances
 * when running on Node.js 22.x or higher.
 *
 * Usage: node cleanupCveFix.js
 */

const { execSync } = require('child_process');

/**
 * Log a message with timestamp
 *
 * @param {string} message - The message to log
 */
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Get the current Node.js version
 *
 * @returns {number} The major version number
 */
function getNodeVersion() {
    const version = process.version;
    const majorVersion = parseInt(version.split('.')[0].substring(1), 10);
    log(`Detected Node.js version: ${version} (major: ${majorVersion})`);
    return majorVersion;
}

/**
 * Execute a shell command and return the output
 *
 * @param {string} command - The command to execute
 * @returns {string} The command output
 */
function executeCommand(command) {
    try {
        const output = execSync(command, { encoding: 'utf-8' });
        return output.trim();
    } catch (error) {
        log(`Error executing command "${command}": ${error.message}`);
        throw error;
    }
}

/**
 * Get list of eusec adapter instances
 *
 * @returns {number[]} Array of instance numbers
 */
function getEusecInstances() {
    log('Retrieving eusec adapter instances...');

    try {
        // Use iobroker CLI directly instead of node path
        const output = executeCommand('iobroker object list system.adapter.eusec.*');
        const instances = [];

        // Parse the output to extract instance numbers
        const lines = output.split('\n');
        for (const line of lines) {
            const match = line.match(/system\.adapter\.eusec\.(\d+)/);
            if (match) {
                const instanceNumber = parseInt(match[1], 10);
                if (!instances.includes(instanceNumber)) {
                    instances.push(instanceNumber);
                }
            }
        }

        log(`Found ${instances.length} eusec instance(s): ${instances.join(', ')}`);
        return instances;
    } catch (error) {
        log(`No eusec instances found or error occurred while listing instances: ${error.message}`);
        return [];
    }
}

/**
 * Fix nodeProcessParams for a specific instance
 *
 * @param {number} instanceNumber - The instance number to fix
 */
function fixInstance(instanceNumber) {
    const objectId = `system.adapter.eusec.${instanceNumber}`;

    log(`Fixing instance ${instanceNumber}...`);
    
    try {
        // Stop the instance first
        log(`Stopping instance ${instanceNumber}...`);
        try {
            executeCommand(`iobroker stop eusec.${instanceNumber}`);
        } catch (error) {
            log(`Instance might already be stopped: ${error.message}`);
        }

        // Clear the nodeProcessParams
        const command = `iobroker object set ${objectId} common.nodeProcessParams=[]`;
        log(`Executing: ${command}`);
        executeCommand(command);
        
        log(`Successfully fixed instance ${instanceNumber}`);
        
        // Start the instance again
        log(`Starting instance ${instanceNumber}...`);
        executeCommand(`iobroker start eusec.${instanceNumber}`);
        
    } catch (error) {
        log(`Failed to fix instance ${instanceNumber}: ${error.message}`);
        throw error;
    }
}

/**
 * Main function
 */
function main() {
    log('=== Cleanup CVE Fix Script Started ===');

    // Check Node.js version
    const nodeVersion = getNodeVersion();

    if (nodeVersion < 22) {
        log(`Node.js version ${nodeVersion}.x is less than 22.x - no action needed`);
        log('=== Cleanup CVE Fix Script Completed Successfully ===');
        process.exit(0);
    }

    log(`Node.js version ${nodeVersion}.x is >= 22.x - proceeding with fix`);

    // Get eusec instances
    const instances = getEusecInstances();

    if (instances.length === 0) {
        log('No eusec instances found - nothing to fix');
        log('=== Cleanup CVE Fix Script Completed Successfully ===');
        process.exit(0);
    }

    // Fix each instance
    let successCount = 0;
    let failCount = 0;

    for (const instanceNumber of instances) {
        try {
            fixInstance(instanceNumber);
            successCount++;
        } catch {
            failCount++;
        }
    }

    log(`Fixed ${successCount} instance(s), ${failCount} failure(s)`);

    if (failCount > 0) {
        log('=== Cleanup CVE Fix Script Completed with Errors ===');
        process.exit(1);
    }

    log('=== Cleanup CVE Fix Script Completed Successfully ===');
    process.exit(0);
}

// Run the main function
if (require.main === module) {
    main();
}

module.exports = { getNodeVersion, getEusecInstances, fixInstance };
