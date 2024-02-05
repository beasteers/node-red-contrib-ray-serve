Deploy Ray Serve Applications with NodeRed.

Initial POC - not fault tolerant

## Demo

```
docker-compose up -d --build
```


[nodered here](http://localhost:1881)




TODO:
 - fault tolerance:
    - add checks to see that Ray is running before deploying the application
    - node status should check the actual application status, not just that it was successfully uploaded
    - redeploy after failure
 - 

## Example flow
```json
[{"id":"1b282ad2a8f263c6","type":"tab","label":"Flow 1","disabled":false,"info":"","env":[]},{"id":"67985cdbc834cbb3","type":"rayConfig","rayAddress":"http://ray:8265","rayAddressType":"str","serveAddress":"http://ray:8000","serveAddressType":"str"},{"id":"4aa8c146e14b5457","type":"inject","z":"1b282ad2a8f263c6","name":"","props":[{"p":"payload"},{"p":"topic","vt":"str"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"","payloadType":"date","x":140,"y":400,"wires":[["0ac04ebf60711eea","71d33ea259873f69"]]},{"id":"8a353f104266b6b7","type":"debug","z":"1b282ad2a8f263c6","name":"debug 1","active":true,"tosidebar":true,"console":false,"tostatus":false,"complete":"payload","targetType":"msg","statusVal":"","statusType":"auto","x":500,"y":400,"wires":[]},{"id":"0ac04ebf60711eea","type":"ray serve","z":"1b282ad2a8f263c6","server":"67985cdbc834cbb3","name":"hello-worlda","route_prefix":"/hello-world","variable_name":"app","package_manager":"pip","dependencies":[],"env_vars":[],"code":"from ray import serve\n\n@serve.deployment\nclass HelloWorld:\n    async def __init__(self):\n        pass\n    async def __call__(self, http_request) -> str:\n        msg: dict = await http_request.json()\n        return {\"payload\": \"Hello from ray!\", \"received\": msg}\n                \napp = HelloWorld.bind()\nserve.run(app)","deployments":[{"name":"HelloWorld"}],"x":310,"y":420,"wires":[["8a353f104266b6b7"]]},{"id":"71d33ea259873f69","type":"ray serve","z":"1b282ad2a8f263c6","server":"67985cdbc834cbb3","name":"App 2","route_prefix":"/asdf","variable_name":"app","package_manager":"pip","dependencies":[],"env_vars":[],"code":"from ray import serve\n\n@serve.deployment\nclass HelloWorld2:\n    async def __call__(self, http_request) -> str:\n        msg: dict = await http_request.json()\n        return {\"payload\": \"Hello from ray 2!\", \"received\": msg}\n                \napp = HelloWorld2.bind()","deployments":[{"name":"HelloWorld2"}],"x":310,"y":360,"wires":[["8a353f104266b6b7"]]}]
```