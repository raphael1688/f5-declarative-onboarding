/**
 * Copyright 2021 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const cloudUtil = require('@f5devcentral/f5-cloud-libs').util;
const Logger = require('./logger');
const PATHS = require('./sharedConstants').PATHS;
const doUtil = require('./doUtil');

const logger = new Logger(module);

/**
 * Handles GSLB parts of a declaration.
 *
 * @class
 */
class GSLBHandler {
    /**
     * Constructor
     *
     * @param {Object} declaration - Parsed declaration.
     * @param {Object} bigIp - BigIp object.
     * @param {EventEmitter} - DO event emitter.
     * @param {State} - The doState.
     */
    constructor(declaration, bigIp, eventEmitter, state) {
        this.declaration = declaration;
        this.bigIp = bigIp;
        this.eventEmitter = eventEmitter;
        this.state = state;
    }

    /**
     * Starts processing.
     *
     * @returns {Promise} A promise which is resolved when processing is complete
     *                    or rejected if an error occurs.
     */
    process() {
        logger.fine('Processing GSLB declaration.');
        if (!this.declaration.Common) {
            return Promise.resolve();
        }
        return handleGSLBGlobals.call(this)
            .then(() => {
                logger.fine('Checking Monitors');
                return handleGSLBMonitor.call(this);
            })
            .then(() => {
                const transactionCommands = [
                    (() => {
                        logger.fine('Checking Data Centers');
                        return handleGSLBDataCenter.call(this);
                    })(),
                    (() => {
                        logger.fine('Checking Servers');
                        return handleGSLBServer.call(this);
                    })(),
                    (() => {
                        logger.fine('Checking Prober Pools');
                        return handleGSLBProberPool.call(this);
                    })()
                ].reduce((array, commands) => array.concat(commands), []);

                if (transactionCommands.length === 0) {
                    return Promise.resolve();
                }

                return this.bigIp.transaction(transactionCommands);
            })
            .catch((err) => {
                logger.severe(`Error processing GSLB declaration: ${err.message}`);
                return Promise.reject(err);
            });
    }
}

function handleGSLBGlobals() {
    const gslbGlobals = this.declaration.Common.GSLBGlobals;
    const promises = [];

    if (!gslbGlobals) {
        return Promise.resolve();
    }

    if (gslbGlobals.general) {
        const gslbGeneral = gslbGlobals.general;
        const body = {
            synchronization: gslbGeneral.synchronizationEnabled ? 'yes' : 'no',
            synchronizationGroupName: gslbGeneral.synchronizationGroupName,
            synchronizationTimeTolerance: gslbGeneral.synchronizationTimeTolerance,
            synchronizationTimeout: gslbGeneral.synchronizationTimeout
        };
        promises.push(this.bigIp.modify(
            PATHS.GSLBGeneral,
            body
        ));
    }

    return Promise.all(promises);
}

function handleGSLBDataCenter() {
    const commands = [];

    doUtil.forEach(this.declaration, 'GSLBDataCenter', (tenant, dataCenter) => {
        if (dataCenter.name) {
            const body = {
                name: dataCenter.name,
                partition: tenant,
                contact: dataCenter.contact,
                enabled: dataCenter.enabled,
                location: dataCenter.location,
                proberFallback: dataCenter.proberFallback,
                proberPreference: dataCenter.proberPreferred
            };

            if (dataCenter.proberPool) {
                body.proberPool = dataCenter.proberPool;
            }

            let method = 'create';
            if (this.state.currentConfig.Common.GSLBDataCenter
                && this.state.currentConfig.Common.GSLBDataCenter[dataCenter.name]) {
                method = 'modify';
            }

            commands.push({
                method,
                path: method === 'create' ? PATHS.GSLBDataCenter : `${PATHS.GSLBDataCenter}/~${tenant}~${dataCenter.name}`,
                body
            });
        }
    });

    return commands;
}

function handleGSLBMonitor() {
    const promises = [];

    doUtil.forEach(this.declaration, 'GSLBMonitor', (tenant, monitor) => {
        if (monitor && monitor.name) {
            const body = {
                name: monitor.name,
                description: monitor.remark || 'none',
                destination: monitor.target,
                interval: monitor.interval,
                timeout: monitor.timeout,
                probeTimeout: monitor.probeTimeout,
                ignoreDownResponse: (monitor.ignoreDownResponseEnabled) ? 'enabled' : 'disabled',
                transparent: (monitor.transparent) ? 'enabled' : 'disabled'
            };

            if (monitor.monitorType !== 'gateway-icmp') {
                body.reverse = (monitor.reverseEnabled) ? 'enabled' : 'disabled';
                body.send = monitor.send || 'none';
                body.recv = monitor.receive || 'none';
            }

            if (monitor.monitorType === 'https') {
                body.cipherlist = monitor.ciphers || 'none';
                body.cert = monitor.clientCertificate || 'none';
            }

            if (monitor.monitorType === 'gateway-icmp' || monitor.monitorType === 'udp') {
                body.probeInterval = monitor.probeInterval;
                body.probeAttempts = monitor.probeAttempts;
            }

            if (monitor.monitorType === 'udp') {
                body.debug = (monitor.debugEnabled) ? 'yes' : 'no';
            }

            const monPath = `${PATHS.GSLBMonitor}/${monitor.monitorType}`;
            promises.push(this.bigIp.createOrModify(monPath, body, null, cloudUtil.MEDIUM_RETRY));
        }
    });

    return Promise.all(promises)
        .catch((err) => {
            logger.severe(`Error creating Servers: ${err.message}`);
            throw err;
        });
}

function handleGSLBServer() {
    const commands = [];

    function mapMonitors(server) {
        if (server.monitors && server.monitors.length > 0) {
            // The monitor property is a string with the monitors connected by ands, instead of an array
            return server.monitors.join(' and ');
        }
        return '';
    }

    doUtil.forEach(this.declaration, 'GSLBServer', (tenant, server) => {
        if (server && server.name) {
            const body = {
                name: server.name,
                description: server.remark || 'none',
                enabled: server.enabled,
                disabled: !server.enabled,
                product: server.serverType,
                proberPreference: server.proberPreferred,
                proberFallback: server.proberFallback,
                proberPool: server.proberPool || 'none',
                limitMaxBps: server.bpsLimit,
                limitMaxBpsStatus: server.bpsLimitEnabled ? 'enabled' : 'disabled',
                limitMaxPps: server.ppsLimit,
                limitMaxPpsStatus: server.ppsLimitEnabled ? 'enabled' : 'disabled',
                limitMaxConnections: server.connectionsLimit,
                limitMaxConnectionsStatus: server.connectionsLimitEnabled ? 'enabled' : 'disabled',
                limitCpuUsage: server.cpuUsageLimit,
                limitCpuUsageStatus: server.cpuUsageLimitEnabled ? 'enabled' : 'disabled',
                limitMemAvail: server.memoryLimit,
                limitMemAvailStatus: server.memoryLimitEnabled ? 'enabled' : 'disabled',
                iqAllowServiceCheck: server.serviceCheckProbeEnabled ? 'yes' : 'no',
                iqAllowPath: server.pathProbeEnabled ? 'yes' : 'no',
                iqAllowSnmp: server.snmpProbeEnabled ? 'yes' : 'no',
                datacenter: server.dataCenter,
                devices: server.devices,
                exposeRouteDomains: server.exposeRouteDomainsEnabled ? 'yes' : 'no',
                virtualServerDiscovery: server.virtualServerDiscoveryMode,
                monitor: mapMonitors(server),
                virtualServers: server.virtualServers.map(vs => ({
                    name: vs.name,
                    description: vs.remark || 'none',
                    destination: `${vs.address}${vs.address.indexOf(':') > -1 ? '.' : ':'}${vs.port}`,
                    enabled: vs.enabled,
                    disabled: !vs.enabled,
                    translationAddress: vs.addressTranslation || 'none',
                    translationPort: vs.addressTranslationPort,
                    monitor: mapMonitors(vs)
                }))
            };

            body.devices.forEach((device) => {
                device.description = device.remark || 'none';
                delete device.remark;
            });

            let method = 'create';
            if (this.state.currentConfig.Common.GSLBServer
                && this.state.currentConfig.Common.GSLBServer[server.name]) {
                method = 'modify';
            }

            commands.push({
                method,
                path: method === 'create' ? PATHS.GSLBServer : `${PATHS.GSLBServer}/~${tenant}~${server.name}`,
                body
            });
        }
    });

    return commands;
}

function handleGSLBProberPool() {
    const commands = [];

    doUtil.forEach(this.declaration, 'GSLBProberPool', (tenant, proberPool) => {
        if (proberPool && proberPool.name) {
            const body = {
                name: proberPool.name,
                description: proberPool.remark || 'none',
                enabled: proberPool.enabled,
                disabled: !proberPool.enabled,
                loadBalancingMode: proberPool.lbMode
            };

            body.members = proberPool.members.map(member => ({
                name: member.server,
                description: member.remark || 'none',
                enabled: member.enabled,
                disabled: !member.enabled,
                order: member.order
            }));

            let method = 'create';
            if (this.state.currentConfig.Common.GSLBProberPool
                && this.state.currentConfig.Common.GSLBProberPool[proberPool.name]) {
                method = 'modify';
            }

            commands.push({
                method,
                path: method === 'create' ? PATHS.GSLBProberPool : `${PATHS.GSLBProberPool}/~${tenant}~${proberPool.name}`,
                body
            });
        }
    });

    return commands;
}

module.exports = GSLBHandler;
