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
 *      statusCount: flow.{id}__statusCount
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
const RayAPI = require("./ray-api");
const axios = require('axios');


/**
 * Creates an app configuration object based on the provided node configuration.
 * 
 * @param {Object} node - The node configuration object.
 * @returns {Object} - The app configuration object.
 */
const createAppConfig = (node) => {
    if(!(node.type === 'ray serve' && node.route_prefix !== undefined)) return;
    let dependencies = ['ray[serve]', ...node.dependencies?.map(d=>d.name)];
    if(node.package_manager === 'conda') {
        dependencies = { dependencies };
    }
    let env_vars = node.env_vars?.reduce((o, x) => (
        { ...o, [x.key]: getField(node, x.type, x.value) }
    ), {}) || {};

    return {
        name: `${node.name || node.route_prefix.replace(/^\//g, '').replace(/\//g, ' ')}`,
        route_prefix: node.route_prefix,
        import_path: `main:${node.variable_name}`,
        runtime_env: {
            working_dir: null, // set after upload.
            [node.package_manager]: dependencies,
            env_vars,
        },
        // deployments: node.deployments?.map(({ DETECTED_FROM_PYTHON, ...d }) => ({
        //     ...d
        // })) || [],

        // custom:
        files: {
            'main.py': node.code || '',
        }
    }
}

function getField(node, kind, value) {
    switch (kind) {
        case 'flow':	// Legacy
            return node.context().flow.get(value);
        case 'global':
            return node.context().global.get(value);
        case 'num':
            return parseInt(value);
        case 'bool':
        case 'json':
            return JSON.parse(value);
        case 'env':
            return process.env[value];
        default:
            return value;
    }
}

// Function to serialize data based on MIME type
function serialize(data, mimeType) {
    switch (mimeType) {
        case 'application/json':
            return JSON.stringify(data);
        case 'text/plain':
            return data.toString();
        case 'image/*':
        case 'audio/*':
        case 'application/octet-stream':
            return data;
        default:
            if (!mimeType || mimeType === 'auto') {
                return serialize(data, 
                    data instanceof ArrayBuffer || data instanceof Uint8Array ? 
                    'application/octet-stream' : 
                    'application/json');
            }
            throw new Error(`Unsupported MIME type: ${mimeType}`);
    }
}

// Function to deserialize data based on MIME type
function deserialize(data, mimeType) {
    switch (mimeType) {
        case 'application/json':
            return JSON.parse(data);
        case 'text/plain':
            return data.toString();
        case 'image/*':
        case 'audio/*':
        case 'application/octet-stream':
            // Return the raw binary data
            return data;
        default:
            throw new Error(`Unsupported MIME type: ${mimeType}`);
    }
}

const safe = (node, fn) => ((...args) => {
    try {
        return fn(...args);
    } catch(e) {
        node?.error({ error: e });
    }
})

const STATES = {
    WAITING: {fill:"yellow",shape:"dot", text:"waiting for api..."},
    DEPLOYING: {fill:"yellow",shape:"ring", text:"deploying..."},
    RUNNING: {fill:"green",shape:"dot", text:"", STATE: "RUNNING"},
    DEPLOY_FAILED: {fill:"red",shape:"dot",text:"deploy failed"},
    DELETING: {fill:"red",shape:"ring",text:"deleting"},
    NOT_STARTED: {fill:"grey",shape:"dot",text:"not started"},
    UNHEALTHY: {fill:"red",shape:"dot",text:"unhealthy"},
    
    ERROR: {fill:"red",shape:"dot",text:"error"},

    ERROR_QUEUED: {fill:"red",shape:"ring", text:"processing"},
    QUEUED: {fill:"blue",shape:"ring", text:"processing"},
    UNKNOWN: {fill:"grey",shape:"dot",text:"unknown"},
}


module.exports = function(RED) {


    
    function RayConfig(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.rayAddress = getField(node, config.rayAddressType, config.rayAddress);
        node.serveAddress = getField(node, config.serveAddressType, config.serveAddress);
        node.publicRayAddress = getField(node, config.publicRayAddressType, config.publicRayAddress) || node.rayAddress;
        
        /* ----------------------- Proxying the Ray Dashboard ----------------------- */
        
        // DISABLED FOR NOW - RED.auth.needsPermission isn't working - just says "Unauthorized"
        node.dashboardEndpoint = '/rayd';
        if (false) {
            const setupProxy = safe(null, () => {
                // Function to handle proxying the request using Axios
                const proxyRequest = (req, res, next) => {
                    const targetUrl = `${node.rayAddress}${req.originalUrl.replace(`${node.dashboardEndpoint}`, '')}`;
                    console.log('Proxying request', req.originalUrl, ' to:', targetUrl);
        
                    const proxy = ({ response, message='unspecified' }) => {
                        if (!response) {
                            node.error(`Proxy request error: ${message}`);
                            res.status(500).send("Proxy error");
                            return;
                        }
                        res.status(response.status);
                        Object.keys(response.headers).forEach(header => {
                            // if(header === 'set-cookie') return;
                            // console.log(header, response.headers[header]);
                            if(header.toLowerCase() !== 'content-type') return;
                            res.setHeader(header, response.headers[header]);
                        });
                        response.data.pipe(res);
                    }
        
                    axios({
                        method: req.method,
                        url: targetUrl,
                        headers: { ...req.headers, host: node.rayAddress.replace(/^https?:\/\//, '') },
                        data: req.body,
                        responseType: 'stream',
                        timeout: 30000
                    })
                    .then(response => { proxy({ response }) })
                    .catch(proxy);
                };
        
                // Register an endpoint accessible only from within the Node-RED editor
                // RED.httpAdmin.use(`${node.dashboardEndpoint}`, RED.auth.needsPermission('flows.write'), (req, res) => proxyRequest(req, res));
                RED.httpAdmin.get(`${node.dashboardEndpoint}/`, RED.auth.needsPermission('flows.read'), (req, res) => proxyRequest(req, res));
                RED.httpAdmin.get(`${node.dashboardEndpoint}/*`, RED.auth.needsPermission('flows.read'), (req, res) => proxyRequest(req, res));
            });
            setupProxy();
        }
    }
    RED.nodes.registerType("rayConfig", RayConfig);

    function RayServe(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        config.name = config.name || config.route_prefix.replace(/^\//g, '').replace(/\//g, ' ');
        node.name = config.name;
		node.route_prefix = config.route_prefix;
		node.variable_name = config.variable_name;
		node.code = config.code;
        node.pip = config.pip;
        node.conda = config.conda;
        node.env_vars = config.env_vars;
		node.server = RED.nodes.getNode(config.server) || {
			rayAddress: process.env.RAY_ADDRESS || "http://ray:8065",
            serveAddress: process.env.RAY_SERVE_ADDRESS || "http://ray:8000",
		};
        node.url = `${node.server.serveAddress.replace(/\/*$/, '')}/${node.route_prefix}`;
        node.statusCount = 0;
        node.queue = node.context().flow.get(`${node.id}__RAY_QUEUE`) || [];
        // console.log("Open:", node.name, node.statusCount, node.queue.length);
        node.maxConcurrent = config.maxConcurrent || 20;
        node.maxBacklogOverflow = config.maxBacklogOverflow || 0;
        node.ready = false;

        /* ----------------------------- Status Messages ---------------------------- */

        // Set the node status message
        node.trackStatus = (status) => {
            status.msg = status.msg || status.text;
            node.lastStatus = status;
            queueStatus();
        }
        
        // Increment or decrement the status count
        const updateStatusCount = (increment, error=false) => {
            node.statusCount = Math.max(0, (node.statusCount || 0) + increment);
            queueStatus();
        }

        // Update node status based on queue length and status count
        const queueStatus = () => {
            if(node?.closingNode) return;
            const queued = node.queue.length;
            const current = node.statusCount <= 20 ? '|'.repeat(node.statusCount) : `:${node.statusCount}`;
            const msg = node.lastStatus?.msg||"";
            const nReplicas = node.lastStatus?.nReplicas>1 ? `[${node.lastStatus.nReplicas}x] ` : '';
            // console.log(nReplicas)
            let text = (
                queued || node.statusCount ?
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
            // pop the next message from the queue
            let [msg, send, done] = node.queue.shift() || [];
            send = send || ((msg) => node.send(msg));
            done = done || (() => {});
            return [msg, send, done];
        }

        const processNext = safe(node, () => {
            if(!node.queue.length) return;
            
            // Only process n messages at a time
            if(node.maxConcurrent && node.statusCount >= node.maxConcurrent) return;
            
            // If the queue is full, route the message to the error output
            if(node.maxBacklogOverflow && node.queue.length >= node.maxBacklogOverflow) {
                let [msg, send, done] = popMessage();
                send([null, { ...msg, ...getNodeMeta(), inputPayload: msg.payload, backlogOverflow: true }]);
                return done();
            }

            // If the node is not ready, wait
            if(node.ready === false) return;

            // Send the message to the serve endpoint
            let [msg, send, done] = popMessage();
            updateStatusCount(1);
            msg = { ...msg, ...getNodeMeta(), inputPayload: msg.payload };

            const startTime = Date.now();
            axios({ method: 'get', url: node.url, data: JSON.stringify(msg.payload) })
                .then(r => {
                    send({ ...msg, payload: r.data, responseTime: Date.now() - startTime }); 
                    updateStatusCount(-1);
                    done();
                    processNext();
                })
                .catch(error => { 
                    if(error?.response?.status !== 503) {
                        node.error({ ...msg, error, responseTime: Date.now() - startTime });
                    }
                    send([null, { ...msg, payload: error?.response?.data, error, responseTime: Date.now() - startTime }]);
                    updateStatusCount(-1, error);
                    done();
                    processNext();
                })
        })

        /* ----------------------------- Event Handlers ----------------------------- */

        node.on('input', safe(node, (msg, send, done) => {
            if(node.maxBacklogOverflow && node.queue.length >= node.maxBacklogOverflow) {
                node.send([null, { ...msg, ...getNodeMeta(), inputPayload: msg.payload, backlogOverflow: true }]);
                return done();
            }

            node.queue.push([msg, send, done]);
            processNext();
        }));

        node.on('close', safe(node, (done) => {
            node.closingNode = true;
            const queue = node.queue;
            node.queue = [];
            node.context().flow.set(`${node.id}__RAY_QUEUE`, queue.map(([msg]) => [msg]));
            node.context().flow.set(`${node.id}__statusCount`, node.statusCount);
        }));

        try {
            for(let i=0; i<Math.min(node.queue.length, node.maxConcurrent); i++) {
                processNext();
            }
        } catch(error) {
            node.error({ error });
        }
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
                            let key = applications[n.name]?.status;
                            n.ready = key === 'RUNNING';
                            console.log(n.name, key, n.ready)
                            let nReplicas = Object.values(applications[n.name]?.deployments || {})?.map(d => d.replicas.length).reduce((a,b)=>isNaN(b) ? a : a+b, 0);
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
                    // Upload failed
                    nodeList.map(n => n?.trackStatus(STATES.ERROR))
                    console.error(e)
                });
        }
    }

    // Get all ray nodes and deploy to servers
    let cleanupFunctions = [];
    const deploy = () => {
        const servers = gatherServers();
        deployToServers(servers, cleanupFunctions);
    }
    // Cancel all status watchers
    const cleanup = () => {
        cleanupFunctions.forEach(cleanup => cleanup());
    }

    /* -------------------------------------------------------------------------- */
    /*                                 Flow Events                                */
    /* -------------------------------------------------------------------------- */

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
