const RayAPI = require("./ray-api");
const axios = require('axios');


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
    RUNNING: {fill:"green",shape:"dot", text:"running."},
    ERROR_QUEUED: {fill:"red",shape:"ring", text:"processing"},
    QUEUED: {fill:"blue",shape:"ring", text:"processing"},
    DEPLOY_FAILED: {fill:"red",shape:"dot",text:"deploy failed"},
    DELETING: {fill:"red",shape:"ring",text:"deleting"},
    NOT_STARTED: {fill:"grey",shape:"dot",text:"not started"},
    UNHEALTHY: {fill:"red",shape:"dot",text:"unhealthy"},
    
    ERROR: {fill:"red",shape:"dot",text:"error"},
}


module.exports = function(RED) {
    // RED.httpAdmin.get("/ray-code", RED.auth.needsPermission('serial.read'), function(req,res) {
    //     serialp.list(function (err, ports) {
    //         res.json(ports);
    //     });
    // });

    function RayConfig(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.rayAddress = getField(node, config.rayAddressType, config.rayAddress);
        node.serveAddress = getField(node, config.serveAddressType, config.serveAddress);

        // DISABLED FOR NOW - RED.auth.needsPermission isn't working - just says "Unauthorized"
        node.dashboardEndpoint = null;
        // node.dashboardEndpoint = '/rayd';

        if (node.dashboardEndpoint) {
            // Register an endpoint accessible only from within the Node-RED editor
            // RED.httpAdmin.use(`${node.dashboardEndpoint}`, RED.auth.needsPermission('flows.write'), (req, res) => proxyRequest(req, res));
            RED.httpAdmin.use(`${node.dashboardEndpoint}`, (req, res) => proxyRequest(req, res));
            RED.httpAdmin.use(`${node.dashboardEndpoint}/*`, (req, res) => proxyRequest(req, res));
    
            // Function to handle proxying the request using Axios
            function proxyRequest(req, res) {
                const targetUrl = `${node.rayAddress}${req.originalUrl.replace(`${node.dashboardEndpoint}`, '')}`;
                console.log('Proxying request', req.originalUrl, ' to:', targetUrl);
    
                axios({
                    method: req.method,
                    url: targetUrl,
                    headers: { ...req.headers, host: node.rayAddress.replace(/^https?:\/\//, '') },
                    data: req.body,
                    responseType: 'stream',
                    timeout: 30000  // Increase the timeout if needed
                })
                .then(response => {
                    res.status(response.status);
                    Object.keys(response.headers).forEach(header => {
                        res.setHeader(header, response.headers[header]);
                    });
                    response.data.pipe(res);
                })
                .catch(({ response, message }) => {
                    if (response) {
                        res.status(response.status);
                        Object.keys(response.headers).forEach(header => {
                            res.setHeader(header, response.headers[header]);
                        });
                        response.data.pipe(res);
                    } else {
                        node.error("Proxy request error: " + message);
                        res.status(500).send("Proxy error");
                    }
                });
            }
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
			rayAddress: "http://localhost:8065",
            serveAddress: "http://localhost:8000",
		};
        const url = `${node.server.serveAddress.replace(/\/*$/, '')}/${node.route_prefix}`

        const updateStatusCount = (increment, error=false) => {
            node.statusCount = Math.max(0, (node.statusCount || 0) + increment);
            node.status({...(error ? STATES.ERROR_QUEUED : STATES.QUEUED), text: error || `${node.statusCount || "done"}`});
        }

        node.on('input', (msg, send, done) => {
            node.warn(url);
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
        // update each server
        for (const sid in servers) {
            const server = RED.nodes.getNode(sid);
            const { nodes, applications } = servers[sid];
            const api = new RayAPI(server.rayAddress);
            const config = api.createConfig({ applications })
            const nodeList = nodes.map(n => RED.nodes.getNode(n));

            nodeList.map(n => n.status(STATES.WAITING))
            api.waitForAPI()
            .then(() => {
                    nodeList.map(n => n.status(STATES.DEPLOYING))
                    return api.upload(config)
                })
                .then(() => {
                    nodeList.map(n => n.status(STATES.RUNNING))
                    api.watchStatus(({ applications }) => {
                        nodeList.forEach(n => {
                            if (n.statusCount > 0 && applications[n.name]?.status === 'running') { return; }
                            if (!(applications[n.name].status in STATES)) {
                                console.log(applications[n.name].status);
                                n?.status({fill:"grey",shape:"dot",text:applications[n.name].status});
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
