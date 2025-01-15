
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
        console.error(e);
        node?.error({ error: e });
    }
})

const safeAsync = (node, fn) => (async (...args) => {
    try {
        return await fn(...args);
    } catch(e) {
        console.error(e);
        node?.error({ error: e });
    }
})


module.exports = {
    getField,
    serialize,
    deserialize,
    safe,
    safeAsync,
    STATES,
}



/* ----------------------- Proxying the Ray Dashboard ----------------------- */

// Came from Ray Config Node
        
// // DISABLED FOR NOW - RED.auth.needsPermission isn't working - just says "Unauthorized"
// node.dashboardEndpoint = '/rayd';
// if (false) {
//     const setupProxy = safe(null, () => {
//         // Function to handle proxying the request using Axios
//         const proxyRequest = (req, res, next) => {
//             const targetUrl = `${node.rayAddress}${req.originalUrl.replace(`${node.dashboardEndpoint}`, '')}`;
//             console.log('Proxying request', req.originalUrl, ' to:', targetUrl);

//             const proxy = ({ response, message='unspecified' }) => {
//                 if (!response) {
//                     node.error(`Proxy request error: ${message}`);
//                     res.status(500).send("Proxy error");
//                     return;
//                 }
//                 res.status(response.status);
//                 Object.keys(response.headers).forEach(header => {
//                     // if(header === 'set-cookie') return;
//                     // console.log(header, response.headers[header]);
//                     if(header.toLowerCase() !== 'content-type') return;
//                     res.setHeader(header, response.headers[header]);
//                 });
//                 response.data.pipe(res);
//             }

//             axios({
//                 method: req.method,
//                 url: targetUrl,
//                 headers: { ...req.headers, host: node.rayAddress.replace(/^https?:\/\//, '') },
//                 data: req.body,
//                 responseType: 'stream',
//                 timeout: 30000
//             })
//             .then(response => { proxy({ response }) })
//             .catch(proxy);
//         };

//         // Register an endpoint accessible only from within the Node-RED editor
//         // RED.httpAdmin.use(`${node.dashboardEndpoint}`, RED.auth.needsPermission('flows.write'), (req, res) => proxyRequest(req, res));
//         RED.httpAdmin.get(`${node.dashboardEndpoint}/`, RED.auth.needsPermission('flows.read'), (req, res) => proxyRequest(req, res));
//         RED.httpAdmin.get(`${node.dashboardEndpoint}/*`, RED.auth.needsPermission('flows.read'), (req, res) => proxyRequest(req, res));
//     });
//     setupProxy();
// }