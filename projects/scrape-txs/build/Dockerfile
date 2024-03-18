FROM oven/bun:1 as build
WORKDIR /app
COPY ./package.json ./bun.lockb ./
RUN bun install
COPY ./src ./src
COPY ./tsconfig.json ./tsconfig.build.json ./
RUN bun tsc --project tsconfig.build.json

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

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH=$PATH:/root/.bun/bin

ARG FUNCTION_DIR="/function"
RUN mkdir -p ${FUNCTION_DIR}
WORKDIR ${FUNCTION_DIR}

RUN bun install aws-lambda-ric

COPY ./package.json ./bun.lockb ./
RUN bun install --production

COPY --from=build /app/dist ./

ENTRYPOINT ["/usr/bin/npx", "aws-lambda-ric"]
CMD ["./lambda.handler"]
