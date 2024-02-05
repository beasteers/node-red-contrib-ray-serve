
module.exports = function(RED) {
    function RayJob(config) {
        RED.nodes.createNode(this,config);

        var node = this;
        node.on('input', (msg) => {
            node.send(msg);
        });
    }
    RED.nodes.registerType("ray job", RayJob);
}




// https://stackoverflow.com/questions/41567175/send-data-on-configuration/41567832#41567832
