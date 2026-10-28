FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951

# Only deployment inputs are substituted; Nginx request variables stay intact.
ENV NGINX_ENVSUBST_FILTER="^L2KINGDOM_(FRONTEND_IP|FRONTEND_PORT|ALLOWED_SUBNET|BACKEND_PORT)$"

RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY public/ /usr/share/nginx/html/observer/
