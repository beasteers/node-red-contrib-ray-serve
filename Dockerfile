FROM nodered/node-red:latest-18

# USER root
# RUN apk add python3 py3-pip
# # RUN apt-get install -y python3.11 python3-pip
# RUN python3 -m pip install -U "ray[default,serve]"
# USER node-red

RUN npm install node-red-contrib-postgresql
RUN mkdir node-red-contrib-ray-jobs
COPY package*.json node-red-contrib-ray-jobs/
RUN npm install ./node-red-contrib-ray-jobs
COPY . node-red-contrib-ray-jobs/
COPY config/settings.js /data/settings.js