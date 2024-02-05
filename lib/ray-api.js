const JSZip = require('jszip');
const axios = require('axios');
const crypto = require('crypto');


// upload_packages_if_needed: https://github.com/ray-project/ray/blob/3627e946dca7dd90b9f99dd6b3641910b10f932e/dashboard/modules/dashboard_sdk.py#L364
// /api/packages: https://github.com/ray-project/ray/blob/acfc70b565bb3716e5c4e819e44cfee234216beb/dashboard/modules/job/job_head.py#L232
class RayAPI {
    constructor(rayAddress) {
        this.address = rayAddress;
    }

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

    uploadPackage({ name, files={} }, callback) {
        if(!name) throw new Error("Please provide a name");
        const packageId = hashDirectory(files);
        const url = `${this.address}/api/packages/gcs/${packageId}.zip`;
        const gcsUri = `gcs://${packageId}.zip`
        console.log(name, url, Object.keys(files));

        // work dir
        const zip = new JSZip();
        for(const key in files) {
            zip.file(key, files[key]);
        }
        console.log("zip", name, Object.keys(files));
        return zip.generateAsync({ type: 'blob' })
            .then(data => {
                console.log("UPLOAD", url);
                return axios({ method: 'put', url, data });
            })
            .then(() => {
                console.log("Upload successful:", url);
                return gcsUri;
            })
            .catch(error => {
                console.error("Error during package upload:", error);
                throw error;
            });
    }

    uploadServeConfig(data) {
        console.log("PUT", `${this.address}/api/serve/applications/`)
        return axios({
            method: 'put',
            url: `${this.address}/api/serve/applications/`,
            data
        })
    }

    upload(config) {
        // Upload packages in parallel
        return Promise.all(config.applications.map(({ files, ...app }) => 
            this.uploadPackage({ name: app.name, files })
                .then(uri => {
                    app.runtime_env.working_dir = uri;
                    return app;
                })
        )).then(applications => {
                console.log(applications);
                return this.uploadServeConfig({ ...config, applications });
            })
            .then(d => {
                console.log('Upload completed!', d.status, d.data)
                return d;
            })
            .catch(e => {
                console.error(e);
                console.error('Error during upload:', e.code, e.config.url)
                throw e;
            });
    }

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
    waitForAPI() {
        const url = `${this.address}/api/version`;
        return this.waitForEndpoint(url, 5000, 1000)
            .catch(e => this.waitForEndpoint(url, 30000, null));
    }

    watchStatus(callback, intervalMs=5000) {
        const poll = () => (
            axios.get(`${this.address}/api/serve/applications/`)
            .then(({ data }) => {
                const result = callback(data);
                if(result === false) return;
                return new Promise(resolve => setTimeout(resolve, intervalMs)).then(poll)
            })
            .catch(e => console.log(e))
        )
        return poll();
    }
}

// https://github.com/ray-project/ray/blob/acfc70b565bb3716e5c4e819e44cfee234216beb/python/ray/_private/runtime_env/packaging.py#L137
function hashDirectory(files, excludes) {
    let hashVal = Buffer.alloc(8);
    _objTravel(files, '', excludes, (filePath, fileContent) => {
        const sha1 = crypto.createHash('sha1');
        sha1.update(filePath.toString());
        sha1.update(fileContent);
        hashVal = xorBytes(hashVal, sha1.digest());
    });
    return hashVal.toString('hex');
}


function _objTravel(obj, path, excludes, handler) {
    for (const [key, value] of Object.entries(obj)) {
        const filePath = path ? `${path}/${key}` : key;

        if (!excludes?.includes(filePath)) {
            if (typeof value === 'object') {
                _objTravel(value, filePath, excludes, handler);
            } else {
                handler(filePath, value);
            }
        }
    }
}
function xorBytes(buffer1, buffer2) {
    const result = Buffer.alloc(Math.max(buffer1.length, buffer2.length));
    for (let i = 0; i < result.length; ++i) {
        result[i] = buffer1[i] ^ buffer2[i];
    }
    return result;
}

module.exports = RayAPI;