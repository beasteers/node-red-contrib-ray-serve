const JSZip = require('jszip');
const axios = require('axios');
const crypto = require('crypto');


// upload_packages_if_needed: https://github.com/ray-project/ray/blob/3627e946dca7dd90b9f99dd6b3641910b10f932e/dashboard/modules/dashboard_sdk.py#L364
// /api/packages: https://github.com/ray-project/ray/blob/acfc70b565bb3716e5c4e819e44cfee234216beb/dashboard/modules/job/job_head.py#L232
/**
 * Represents the RayAPI class.
 * 
 * @class
 * @classdesc A class that provides methods for interacting with the Ray API.
 */
class RayAPI {
    /**
     * Creates a new instance of the RayApi class.
     * @param {string} rayAddress - The address of the Ray server (and dashboard). Typically port 8265 (e.g. `http://localhost:8265`).
     */
    constructor(rayAddress) {
        this.address = rayAddress;
    }

    
    /**
     * Creates a configuration object for the Ray API.
     * 
     * See docs here: [serve-rest-api](https://docs.ray.io/en/latest/serve/api/index.html#serve-rest-api)
     * 
     * @param {Object} options - The options for creating the configuration.
     * @param {Array} options.applications - The list of applications.
     * @param {string} [options.root_path='/'] - The root path.
     * @returns {Object} The configuration object.
     */
    createConfig({ applications, root_path='/' }) {
        return {
            proxy_location: "EveryNode",
            http_options: {
                host: '0.0.0.0',
                port: 8000,
                root_path,
                request_timeout_s: null,
                keep_alive_timeout_s: 5
            },
            applications
        }
    }

    uploadPackage({ name, files={} }) {
        if(!name) throw new Error("Please provide a name");
        const packageId = hashDirectory(files);
        const url = `${this.address}/api/packages/gcs/${packageId}.zip`;
        const gcsUri = `gcs://${packageId}.zip`
        // console.log(name, url, Object.keys(files));

        // If the code package does not exist (based on the code hash), zip and upload it
        return axios.head(url)
            .then(r => { 
                // console.log("RAY: Package already exists:", name, url, r.status); 
                return gcsUri 
            })
            .catch(() => {
                const zip = new JSZip();
                for(const key in files) {
                    zip.file(key, files[key]);
                }
                return zip.generateAsync({ type: 'blob' })
                    .then(data => axios({ method: 'put', url, data }))
                    .then(r => { 
                        // console.log("RAY: Package uploaded:", name, url, r.status); 
                        return gcsUri 
                    })
                    .then(() => gcsUri)
                    .catch(e => { 
                        console.error("RAY: Error during package upload:", e); 
                        throw e 
                    });
            })
            
    }

    /**
     * Uploads and serves the configuration data.
     * 
     * See docs here: [serve-rest-api](https://docs.ray.io/en/latest/serve/api/index.html#serve-rest-api)
     * 
     * @param {Object} data - The data to be uploaded.
     * @returns {Promise} - A promise that resolves with the response from the server.
     */
    uploadServeConfig(data) {
        // console.log("PUT", `${this.address}/api/serve/applications/`)
        return axios({
            method: 'put',
            url: `${this.address}/api/serve/applications/`,
            data
        })
    }

    /**
     * Uploads packages in parallel and returns a Promise that resolves to the result of the upload.
     * 
     * @param {Object} config - The configuration object.
     * @param {Array} config.applications - An array of application objects.
     * @param {string} config.applications[].name - The name of the application.
     * @param {Array} config.applications[].files - An array of files to be uploaded.
     * @returns {Promise} A Promise that resolves to the result of the upload.
     * @throws {Error} If an error occurs during the upload process.
     */
    upload(config) {
        // Upload packages in parallel
        return Promise.all(config.applications.map(({ files, ...app }) => 
            this.uploadPackage({ name: app.name, files })
                .then(uri => {
                    app.runtime_env.working_dir = uri;
                    return app;
                })
        )).then(applications => {
                return this.getApplications()
                    .then(current => {
                        const currentApplications = Object.values(current.applications).map(
                            x=>x.status === 'RUNNING' ? x.deployed_app_config : null).filter(x=>x)
                        if(isDeepEqual(applications, currentApplications)) {
                            // console.log("RAY: Applications are the same, skipping upload");
                            return { status: 204, data: '' };
                        }
                        // console.log("RAY: Applications are different, uploading");
                        return this.uploadServeConfig({ ...config, applications });
                    });
            })
            .then(d => {
                // if(d.status !== 204) console.log('RAY: Upload completed!', d.status, d.data)
                return d;
            })
            .catch(e => {
                console.error('RAY: Error during upload:', e.code, e.config.url)
                console.error('RAY:', e);
                throw e;
            });
    }

    /**
     * Waits for an endpoint to become available by polling it at regular intervals.
     * @param {string} url - The URL of the endpoint to poll.
     * @param {number} [intervalMs=5000] - The interval in milliseconds between each poll attempt.
     * @param {number} [maxAttempts=2500] - The maximum number of poll attempts before giving up.
     * @returns {Promise} - A promise that resolves when the endpoint becomes available.
     * @throws {Error} - If the maximum number of poll attempts is exceeded.
     */
    waitForEndpoint(url, intervalMs=5000, maxAttempts=2500) {
        let attempts = 0;
        const poll = () => (
            axios.get(url).catch(error => {
                attempts++;
                if(maxAttempts && attempts > maxAttempts) throw Error(`Exceeded max attempts: ${attempts}`)
                return new Promise(resolve => setTimeout(resolve, intervalMs)).then(poll)
            })
        )
        return poll();
    }


    /**
     * Waits for the API to be available.
     * 
     * @returns {Promise} A promise that resolves when the API is available.
     */
    waitForAPI() {
        const url = `${this.address}/api/version`;
        return this.waitForEndpoint(url, 5000, 1000)
            .catch(e => this.waitForEndpoint(url, 30000, null));
    }

    /**
     * Gets the list of applications.
     * 
     * @returns {Promise} A promise that resolves with the list of applications.
     * @throws {Error} If an error occurs during the request.
     */
    getApplications() {
        return axios.get(`${this.address}/api/serve/applications/`)
            .then(r => r.data)
            .catch(e => { console.error(e); throw e });
    }

    /**
     * Watches the status of the application by periodically making a GET request to the specified address.
     * 
     * @param {Function} callback - The callback function to be executed with the response data.
     * @param {number} [intervalMs=5000] - The interval in milliseconds between each status check.
     * @returns {Promise} - A promise that resolves when the status check is stopped.
     */
    watchStatus(callback, intervalMs=5000, shortIntervalMs=800, shortDuration=10000) {
        return new Cancellable(async (c) => {
            let count = 0;
            while (true) {
                try {
                    const { data } = await axios.get(`${this.address}/api/serve/applications/`);
                    const result = callback(data);
                    if (result === false || c.cancelled) return;
                    let interval = intervalMs;
                    if (count * shortIntervalMs < shortDuration) {
                        count++;
                        interval = shortIntervalMs;
                    }
                    await new Promise(resolve => setTimeout(resolve, interval));
                } catch (e) {
                    console.error(`Error during Ray Application status check: ${e}`);
                    await new Promise(resolve => setTimeout(resolve, shortIntervalMs));
                }
            }
        });
    }
}




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

        // custom:
        files: {
            'main.py': node.code || '',
        }
    }
}



class Cancellable {
    constructor(func) {
        this.cancelled = false;
        this.promise = func(this);
    }
    cancel() {
        this.cancelled = true;
    }
}

// https://github.com/ray-project/ray/blob/acfc70b565bb3716e5c4e819e44cfee234216beb/python/ray/_private/runtime_env/packaging.py#L137
/**
 * Calculates the hash of a directory based on its files and excludes.
 * 
 * @param {Array<string>} files - The list of files in the directory.
 * @param {Array<string>} excludes - The list of files to exclude from the hash calculation.
 * @returns {string} The hash of the directory.
 */
function hashDirectory(files, excludes) {
    const sha1 = crypto.createHash('sha1');
    _objTravel(files, '', excludes, (filePath, fileContent) => {
        sha1.update(`\n~~~~ PATH > ${filePath.toString()}`);
        sha1.update(fileContent);
    });
    return sha1.digest('hex');
}


function _objTravel(obj, path, excludes, handler) {
    for (const key of Object.keys(obj).sort()) {
        const filePath = path ? `${path}/${key}` : key;
        const value = obj[key];
        
        if (!excludes?.includes(filePath)) {
            if (typeof value === 'object') {
                _objTravel(value, filePath, excludes, handler);
            } else {
                handler(filePath, value);
            }
        }
    }
}


const isDeepEqual = (object1, object2) => {
    if(!isObject(object1) || !isObject(object2)) {
        return object1 === object2;
    }
    const keys1 = Object.keys(object1);
    const keys2 = Object.keys(object2);
    if (keys1.length !== keys2.length) {
        // console.log("Different lengths", keys1.length, keys2.length);
        // console.log(keys1);
        // console.log(keys2);
        return false;
    }
    for (const key of keys1) {
      if (!isDeepEqual(object1[key], object2[key])) {
        // console.log("Different keys", key, object1[key], object2[key]);
        return false;
      }
    }
    return true;
};
const isObject = (object) => object != null && typeof object === "object";


module.exports = {
    RayAPI, createAppConfig
};