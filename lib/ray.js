const RayAPI = require("./ray-api");
const axios = require('axios');


/**
 * Creates an app configuration object based on the provided node configuration.
 * 
 * @param {Object} node - The node configuration object.
 * @returns {Object} - The app configuration object.
 */
const createAppConfig = (node) => {
    if(!(node.type === 'ray serve' && node.name !== undefined)) return;
    let dependencies = ['ray[serve]', ...node.dependencies?.map(d=>d.name)];
    if(node.package_manager === 'conda') {
        dependencies = { dependencies };
    }
    let env_vars = node.env_vars?.reduce((o, x) => (
        { ...o, [x.key]: getField(node, x.type, x.value) }
    ), {}) || {};

    return {
        name: `${node.name}`,
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
    RUNNING: {fill:"green",shape:"dot", text:"ready."},
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
        var node = this;
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
        const url = `${node.server.serveAddress.replace(/\/*$/, '')}/${node.route_prefix}`

        /* -------------------------- Node Message Handling ------------------------- */

        const updateStatusCount = (increment, error=false) => {
            node.statusCount = Math.max(0, (node.statusCount || 0) + increment);
            node.status({...(error ? STATES.ERROR_QUEUED : STATES.QUEUED), text: error || `${node.statusCount || "done"}`});
        }

        node.on('input', (msg, send, done) => {
            // node.warn(url);
            updateStatusCount(1);
            axios({ method: 'get', url, data: JSON.stringify(msg.payload) })
                .then(r => { send({ ...msg, payload: r.data }); updateStatusCount(-1) })
                .catch(error => { node.warn(error); updateStatusCount(-1, error) })
                .finally(x => { done() });
        });
    }
    RED.nodes.registerType("ray serve", RayServe);


    RED.events.on("flows:started", () => {
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
            const nodeList = nodes.map(n => RED.nodes.getNode(n));

            nodeList.map(n => n.status(STATES.WAITING))
            api.waitForAPI()
                .then(() => {
                    // First upload all app code
                    nodeList.map(n => n.status(STATES.DEPLOYING))
                    return api.upload(config)
                })
                .then(() => {
                    // Then watch the status of each deployment
                    nodeList.map(n => n.status(STATES.RUNNING))
                    api.watchStatus(({ applications }) => {
                        nodeList.forEach(n => {
                            if (n.statusCount > 0 && applications[n.name]?.status == 'RUNNING') { return; }
                            if (!(applications[n.name]?.status in STATES)) {
                                n?.status({...STATES.UNKNOWN, text:applications[n.name]?.status});
                                return;
                            }
                            n?.status(STATES[applications[n.name].status])
                        })
                    })
                })
                .catch(e => {
                    nodeList.map(n => n.status(STATES.ERROR))
                    console.error(e)
                });
        }
    })
}


// https://stackoverflow.com/questions/41567175/send-data-on-configuration/41567832#41567832
