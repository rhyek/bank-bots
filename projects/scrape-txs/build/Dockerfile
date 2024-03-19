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

COPY ./package.json ./bun.lockb ./
RUN bun install

COPY lambda.js ./
COPY ./src ./src

ENTRYPOINT ["/usr/bin/npx", "aws-lambda-ric"]
CMD ["./lambda.handler"]
