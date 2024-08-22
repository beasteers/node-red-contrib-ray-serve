import requests
from fastapi import FastAPI
from ray import serve

# 1: Define a FastAPI app and wrap it in a deployment with a route handler.
app = FastAPI()

@serve.deployment
@serve.ingress(app)
class FastAPIDeployment:
    # FastAPI will automatically parse the HTTP request for us.
    @app.get("/a")
    def say_hello(self, name: str) -> str:
        return f"Hello a {name}!"


# 2: Deploy the deployment.
serve.run(FastAPIDeployment.bind(), route_prefix="/")
