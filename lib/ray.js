/**
 * 
 * This file contains the Node-RED nodes for the Ray integration.
 * 
 * 
 * RayConfig Node:
 *    flows:started:
 *      gather all ray serve nodes and construct config
 *      deploy to ray cluster
 *      watch status of deployments
 *    flows:stopped:
 *      cancel watch status poll function
 * 
 * RayServe Node:
 *    state:
 *      queue: flow.{id}__RAY_QUEUE
 *      statusCount: flow.{id}__STATUS_COUNT
 *    init:
 *      processNext() for each item in queue
 *    input:
 *      push to queue
 *      processNext()
 *    close:
 *      save queue to flow storage
 * 
 * 
 * Test remove/disable nodes?
 * 
 */
const axios = require('axios');
const { 
    RayAPI, 
    createAppConfig,
} = require("./ray-api");
const {
    safe, safeAsync,
    STATES,
    getField,
} = require('./util');



module.exports = function(RED) {

    function RayConfig(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.rayAddress = getField(node, config.rayAddressType, config.rayAddress);
        node.serveAddress = getField(node, config.serveAddressType, config.serveAddress);
        node.publicRayAddress = getField(node, config.publicRayAddressType, config.publicRayAddress) || node.rayAddress;
    }
    RED.nodes.registerType("rayConfig", RayConfig);


    function RayServe(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Get the server configuration from the nodered config
        
        // the name of the node, defaults to the route prefix
        config.name = config.name || config.route_prefix.replace(/^\//g, '').replace(/\//g, ' ');
        // the name of the node
        node.name = config.name;
        // the url used to access the function
		node.route_prefix = config.route_prefix;
        // the name of the variable containing the deployment (e.g. "app")
		node.variable_name = config.variable_name;
        // the python source code of the function
		node.code = config.code;
        // list of packages to install
        node.pip = config.pip;
        // list of conda packages to install
        node.conda = config.conda;
        // dict of environment variables
        node.env_vars = config.env_vars;
        // ray serve config node
		node.server = RED.nodes.getNode(config.server) || {
			rayAddress: process.env.RAY_ADDRESS || "http://ray:8065",
            serveAddress: process.env.RAY_SERVE_ADDRESS || "http://ray:8000",
		};
        // the url used to access the ray serve cluster
        node.url = `${node.server.serveAddress.replace(/\/*$/, '')}/${node.route_prefix}`;
        
        // node queue options
        
        // how many function calls can be processed concurrently before we start a backlog?
        node.maxConcurrent = config.maxConcurrent || 20;
        // how many function calls can be in the backlog before we start dropping them?
        node.maxBacklogOverflow = config.maxBacklogOverflow || 0;
        node.maxFcount = 1000000000000;
        
        // Initialize the node state
        
        // Get the queue from the flow storage
        node.queue = node.context().flow.get(`${node.name}__RAY_QUEUE`) || [];
        node.fcount = node.context().flow.get(`${node.name}__RAY_FCOUNT`) || 0;
        node.ready = false;
        node.statusCount = 0;
        node.appState = null;
        // console.log("Open:", node.name, node.statusCount, node.queue.length);

        /* ----------------------------- Status Messages ---------------------------- */

        // Set the node status message - used by the api watcher
        node.trackStatus = (status) => {
            status.msg = status.msg || status.text;
            node.lastStatus = status;
            queueStatus();
        }
        
        // Increment or decrement the status count - used by the node input handler
        const updateStatusCount = (increment, error=false) => {
            node.statusCount = Math.max(0, (node.statusCount || 0) + increment);
            queueStatus();
        }

        // Update node status based on queue length and status count
        const queueStatus = () => {
            if(node?.closingNode) return;
            const queued = node.queue.length;
            const current = node.statusCount <= 20 ? '|'.repeat(node.statusCount) : `|${node.statusCount}`;
            const msg = node.lastStatus?.msg||"";
            const nReplicas = node.lastStatus?.nReplicas>1 ? `[${node.lastStatus.nReplicas}x] ` : '';
            // console.log(nReplicas)
            let text = (
                queued + node.statusCount ?
                `${queued} ${current} ${msg}`
                : msg
            );
            text = `${nReplicas}${text}`;
            node.status({ ...node?.lastStatus, text });
        }


        // Get metadata to append to messages
        const getNodeMeta = () => ({
            route: node.route_prefix,
            rayQueueCountCurrent: node.statusCount,
            rayQueueCountBacklog: node.queue.length,
            nReplicas: node.lastStatus?.nReplicas || 0,
        })

        /* -------------------------- Node Message Handling ------------------------- */

        const popMessage = () => {
            let [msg, send, done] = node.queue.shift() || [];
            send = send || ((msg) => node.send(msg));
            done = done || (() => {});
            return [msg, send, done];
        }

        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const processNext = async () => {
            while (true) {
                if (node.closingNode) return;  // node is closing
                if (!node.queue.length) {
                    return;  // no messages to process
                }
                
                // If the queue is full, route the message to the error output
                if(node.maxBacklogOverflow && node.queue.length >= node.maxBacklogOverflow) {
                    // console.log(`backpressure: ${node.name}`);
                    let [msg, send, done] = popMessage();
                    send([null, { ...msg, ...getNodeMeta(), backpressure: true, rejectionCause: 'backpressure' }]);
                    done();
                    if(node.ready) {
                        processNext();
                    }
                    continue;
                }

                if (node.ready === false) {
                    // console.log(`Node not ready: ${node.name}`);
                    await delay(1000);  // wait for the node to be ready
                    continue;
                }
                
                if (node.maxConcurrent && node.statusCount > node.maxConcurrent) {
                    // console.log(`max concurrent: ${node.name} ${node.statusCount}`);
                    await delay(100);  // wait for messages to finish
                    continue;
                }
                
                break;
            }

            await processNextInner();  // process the next message
        };

        const getSend = (send, done) => {
            if(node.closingNode || node.wires === undefined) {
                // console.log('asdf', node.name)
                let newNode = RED.nodes.getNode(node.id);
                if(!newNode || newNode.closingNode) {
                    // node.name == 'batched_translate' && 
                    console.error(`Node ${node.name}(${node.id}) is closed. Dropping message.`);
                    return [() => {}, () => {}];
                }
                console.log(`New node ${node.name}(${node.id}).`);
                return [msg => newNode.send(msg), () => {}];
            } else if(send && done) {
                return [send, done];
            } else {
                return [msg => node.send(msg), () => {}];
            }
        }

        // node.msgIds = {};
        const processNextInner = safeAsync(node, async () => {
            if (!node.queue.length) return;

            // Send the message to the serve endpoint
            let [msg, send, done] = node.queue.shift() || [];
            updateStatusCount(1);
            msg = { ...msg, ...getNodeMeta(), inputPayload: msg.payload };

            const startTime = Date.now();
            try {
                const response = await axios({ method: 'get', url: node.url, data: JSON.stringify(msg.payload) });
                [send, done] = getSend(send, done);
                send({ ...msg, payload: response.data, responseTime: Date.now() - startTime });
                done?.();
            } catch (e) {
                let error = {
                    response: e.response,
                    message: `${e.status}: ${e.response?.data}`,
                    stack: e.stack,
                };
                // console.error(e);
                // console.error(error);
                updateStatusCount(0, error);
                let responseTime = Date.now() - startTime;

                [send, done] = getSend(send, done);
                if (e?.response?.status === 503) {
                    // send = send || node.send;
                    // console.log(`backpressure: ${node.name}`);
                    send([[], { ...msg, error, responseTime, backpressure: true, rejectionCause: 'backpressure' }]);
                    done?.();
                } 
                else if(e?.code === 'ECONNREFUSED') {
                    // console.error(`Connection refused: ${node.url}`);
                    send([[], { ...msg, payload: error?.response?.data, error, responseTime, rejectionCause: 'ECONNREFUSED' }]);
                    done?.();
                }
                else {
                    // console.error(e);
                    done?.({ ...msg, payload: error?.response?.data, error, responseTime, rejectionCause: 'error' });
                }
            } finally {
                updateStatusCount(-1);
                processNext();
            }
        });

        /* ----------------------------- Event Handlers ----------------------------- */

        node.on('input', safe(node, (msg, send, done) => {
            node.fcount = (node.fcount + 1) % node.maxFcount;
            msg.fcount = node.fcount;

            // if(node.maxBacklogOverflow && node.queue.length >= node.maxBacklogOverflow) {
            //     node.send([null, { ...msg, ...getNodeMeta(), inputPayload: msg.payload, backpressure: true }]);
            //     processNext();
            //     return done();
            // }

            node.queue.push([msg, send, done]);
            processNext();
        }));

        node.on('close', safe(node, (done) => {
            // Mark the node as closing so that it doesn't try to reference a non-existent node object
            node.closingNode = true;
            // Save the queue to the flow storage
            const queue = node.queue;
            node.queue = [];
            // queue.forEach(([msg, send, done]) => {
            //     send([null, { ...msg, ...getNodeMeta(), inputPayload: msg.payload, backpressure: true }]);
            //     done();
            // });
            node.context().flow.set(`${node.name}__RAY_QUEUE`, queue.map(([msg]) => [msg]));
            node.context().flow.set(`${node.name}__STATUS_COUNT`, node.statusCount);
            node.context().flow.set(`${node.name}__RAY_FCOUNT`, node.fcount);
            done?.();
        }));

        // Initialize the node, submitting all queued messages
        node.initProcessNext = () => {
            console.log(`Initializing Ray Serve Node: ${node.name} ${node.queue.length} queued. starting ${Math.min(node.queue.length, node.maxConcurrent) - node.statusCount}.`);
            try {
                processNext();
                for(let i=0; i<(node.maxConcurrent || 6); i++) {
                    processNext();
                }
            } catch(error) {
                node.error({ error });
            }
        }
        
        node.initProcessNext();
    }
    RED.nodes.registerType("ray serve", RayServe);


    /* -------------------------------------------------------------------------- */
    /*                                   Deploy                                   */
    /* -------------------------------------------------------------------------- */

    // Function to gather all server configurations and their applications into a single object
    const gatherServers = () => {
        const servers = {};
        RED.nodes.eachNode(n => {
            // only process ray serve nodes that have a server and are not disabled
            if(n.type !== "ray serve" || !n.server || n.d === true) return;
            const app = createAppConfig(n)
            if(app) {
                // Add the application to the server's list
                servers[n.server] = servers[n.server] || {applications: [], nodes: []};
                servers[n.server].applications.push(app);
                servers[n.server].nodes.push(n.id);
            }
        })
        return servers;
    }

    // Function to deploy all applications to the ray cluster
    const deployToServers = (servers, cleanupFunctions) => {
        for (const sid in servers) {
            // Get server configuration
            const server = RED.nodes.getNode(sid);

            // Create config
            const { nodes, applications } = servers[sid];
            const api = new RayAPI(server.rayAddress);
            const config = api.createConfig({ applications })
            const nodeList = nodes.map(n => RED.nodes.getNode(n)).filter(n => n);
            if(!nodeList.length) return;
            
            // Deploy to server
            nodeList.map(n => n?.trackStatus(STATES.WAITING))
            api.waitForAPI()
                .then(() => {
                    // First upload all app code
                    nodeList.map(n => n?.trackStatus(STATES.DEPLOYING))
                    return api.upload(config)
                })
                .then(() => {
                    // Then watch the status of each deployment
                    nodeList.map(n => n?.trackStatus(STATES.RUNNING))
                    let ws = api.watchStatus(({ applications, ...other }) => {
                        applications = applications || {};
                        
                        // Update the status of each node
                        nodeList.forEach(n => {
                            let app = applications[n.name];
                            n.appState = app;
                            let key = app?.status;
                            n.ready = key === 'RUNNING';
                            if(key === 'DEPLOY_FAILED' || key === 'ERROR' || key === 'UNHEALTHY') {
                                console.error(app);
                            }
                            // console.log(n.name, key, n.ready)
                            let nReplicas = Object.values(app?.deployments || {})?.map(d => d.replicas.length).reduce((a,b)=>isNaN(b) ? a : a+b, 0);
                            n?.trackStatus({
                                ...(STATES?.[key] || {...STATES.UNKNOWN, text: key}),
                                nReplicas,
                            });
                        })

                        // Detect Ray restarts and re-upload
                        if(!Object.keys(applications).length) {
                            nodeList.map(n => { n.ready = false })
                            nodeList.map(n => n?.trackStatus(STATES.DEPLOYING))
                            return api.upload(config);
                        }
                    });
                    cleanupFunctions.push(() => ws.cancel());
                })
                .catch(e => {
                    n.appState = e;
                    // Upload failed
                    nodeList.map(n => n?.trackStatus(STATES.ERROR))
                    console.error(e)
                });
        }
    }
    
    /* -------------------------------------------------------------------------- */
    /*                                 Flow Events                                */
    /* -------------------------------------------------------------------------- */


    // Get all ray nodes and deploy to servers
    let cleanupFunctions = [];
    const deploy = (() => {
        const servers = gatherServers();
        deployToServers(servers, cleanupFunctions);
    })
    // Cancel all status watchers
    const cleanup = (() => {
        cleanupFunctions.forEach(fn => fn());
    })

    RED.events.on("flows:started", safe(console, () => {
        try {
            deploy();
        } catch(e) {
            console.error(e);
        }
    }));
    // Add a listener for flow stop event
    RED.events.on("flows:stopped", safe(console, () => {
        // Cancel all status watchers
        try {
            cleanup();
        } catch(e) {
            console.error(e);
        }
    }));

}


// https://stackoverflow.com/questions/41567175/send-data-on-configuration/41567832#41567832
