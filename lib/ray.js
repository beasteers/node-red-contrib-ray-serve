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
        deployments: node.deployments?.map(({ DETECTED_FROM_PYTHON, ...d }) => ({
            ...DETECTED_FROM_PYTHON, ...d
        })) || [],

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

        /* ----------------------- Proxying the Ray Dashboard ----------------------- */

        // DISABLED FOR NOW - RED.auth.needsPermission isn't working - just says "Unauthorized"
        node.dashboardEndpoint = '/rayd';

        if (process.env.RAY_DASHBOARD_ENABLED) {
            // Function to handle proxying the request using Axios
            const proxyRequest = (req, res) => {
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
            }

            // Register an endpoint accessible only from within the Node-RED editor
            // RED.httpAdmin.use(`${node.dashboardEndpoint}`, RED.auth.needsPermission('flows.write'), (req, res) => proxyRequest(req, res));
            RED.httpAdmin.use(`${node.dashboardEndpoint}`, (req, res) => proxyRequest(req, res));
            RED.httpAdmin.use(`${node.dashboardEndpoint}/*`, (req, res) => proxyRequest(req, res));
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
        const MAX_CONCURRENT = 20;

        /* ----------------------------- Status Messages ---------------------------- */

        node.trackStatus = (status) => {
            status.msg = status.msg || status.text;
            node.lastStatus = status;
            queueStatus();
        }
        
        const updateStatusCount = (increment, error=false) => {
            node.statusCount = Math.max(0, (node.statusCount || 0) + increment);
            queueStatus();
        }

        const queueStatus = () => {
            if(node?.closingNode) return;
            const queued = node.queue.length;
            const current = node.statusCount <= 20 ? '|'.repeat(node.statusCount) : node.statusCount;
            const msg = node.lastStatus?.msg||"";
            const nReplicas = node.lastStatus?.nReplicas>1 ? `[${node.lastStatus.nReplicas}x] ` : '';
            // console.log(nReplicas)
            let text = (
                queued || node.statusCount ?
                `${queued} : ${current} ${msg}`
                : msg
            );
            text = `${nReplicas}${text}`;
            node.status({ ...node.lastStatus, text });
        }


        /* -------------------------- Node Message Handling ------------------------- */

        const processNext = () => {
            // while(node.queue.length && node.statusCount < MAX_CONCURRENT) {}
            // console.log("Process:", node.name, node.queue.length, node.statusCount);
            if(!node.queue.length || node.statusCount >= MAX_CONCURRENT) return;

            let [msg, send, done] = node.queue.shift() || [];
            send = send || ((msg) => node.send(msg));
            done = done || (() => {});
            updateStatusCount(1);
            msg = { 
                ...msg, 
                inputPayload: msg.payload, 
                route: node.route_prefix,
                rayQueueCountCurrent: node.statusCount,
                rayQueueCountBacklog: node.queue.length,
                nReplicas: node.lastStatus?.nReplicas || 0,
            };

            const startTime = Date.now();
            axios({ method: 'get', url: node.url, data: JSON.stringify(msg.payload) })
                .then(r => {
                    send({ ...msg, payload: r.data, responseTime: Date.now() - startTime }); 
                    updateStatusCount(-1);
                    done();
                    processNext();
                })
                .catch(error => { 
                    node.error({ ...msg, error, responseTime: Date.now() - startTime });
                    updateStatusCount(-1, error);
                    done();
                    processNext();
                })
        }
        for(let i=0; i<Math.min(node.queue.length, MAX_CONCURRENT); i++) {
            processNext();
        }

        node.on('input', (msg, send, done) => {
            node.queue.push([msg, send, done]);
            try {
                processNext();
            } catch(error) {
                node.error({ ...msg, error });
            }
        });

        node.on('close', (done) => {
            try {
                node.closingNode = true;
                const queue = node.queue;
                node.queue = [];
                node.context().flow.set(`${node.id}__RAY_QUEUE`, queue.map(([msg]) => [msg]));
                node.context().flow.set(`${node.id}__statusCount`, node.statusCount);
                done();
            } catch(error) {
                node.error({ ...msg, error });
            }
        });
    }
    RED.nodes.registerType("ray serve", RayServe);

    let cleanupFunctions = [];
    RED.events.on("flows:started", () => {
      try {
        // gather all nodes per server
        const servers = {};
        RED.nodes.eachNode(n => {
            if(n.type !== "ray serve" || !n.server) return;
            const app = createAppConfig(n)
            if(app) {
                servers[n.server] = servers[n.server] || {applications: [], nodes: []};
                servers[n.server].applications.push(app);
                servers[n.server].nodes.push(n.id);
            }
        })

        /* --------------------------------- Deploy --------------------------------- */

        for (const sid in servers) {
            const server = RED.nodes.getNode(sid);
            const { nodes, applications } = servers[sid];
            const api = new RayAPI(server.rayAddress);
            const config = api.createConfig({ applications })
            const nodeList = nodes.map(n => RED.nodes.getNode(n)).filter(n => n);

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
                    let ws = api.watchStatus(({ applications }) => {
                        nodeList.forEach(n => {
                            let key = applications[n.name]?.status;
                            let nReplicas = Object.values(applications[n.name]?.deployments)?.map(d => d.replicas.length).reduce((a,b)=>isNaN(b) ? a : a+b, 0);
                            n?.trackStatus({
                                ...(STATES?.[key] || {...STATES.UNKNOWN, text: key}),
                                nReplicas,
                            });
                        })
                    })
                    cleanupFunctions.push(() => ws.cancel());
                })
                .catch(e => {
                    nodeList.map(n => n?.trackStatus(STATES.ERROR))
                    console.error(e)
                });
        }
      } catch(e) {
        console.error(e);
      }
    })
    // Add a listener for flow stop event
    RED.events.on("flows:stopped", () => {
        try {
            cleanupFunctions.forEach(cleanup => cleanup());
        } catch(e) {
            console.error(e);
        }
    });
}


// https://stackoverflow.com/questions/41567175/send-data-on-configuration/41567832#41567832
