FROM node:18-buster-slim as build
WORKDIR /app
COPY ./package.json ./
RUN npm install
COPY ./src ./src
COPY ./tsconfig.json ./tsconfig.build.json ./
RUN npm run build

# runner

FROM mcr.microsoft.com/playwright:v1.42.1-jammy

RUN apt-get update && \
  apt-get install -y \
  g++ \
  make \
  autoconf \
  cmake \
  unzip \
  libtool \
  libcurl4-openssl-dev \
  python3

ENV NPM_CONFIG_CACHE=/tmp/.npm

ARG FUNCTION_DIR="/function"
RUN mkdir -p ${FUNCTION_DIR}
WORKDIR ${FUNCTION_DIR}

COPY ./package.json ./
RUN npm install --production
RUN npm install aws-lambda-ric

COPY --from=build /app/dist ./

ENTRYPOINT ["/usr/bin/npx", "aws-lambda-ric"]
CMD ["lambda.handler"]
