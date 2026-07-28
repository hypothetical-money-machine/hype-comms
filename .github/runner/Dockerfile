FROM ubuntu:24.04

ARG RUNNER_VERSION=2.336.0
ARG RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d
ARG AWS_CLI_VERSION=2.36.9

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    fakeroot \
    file \
    git \
    git-lfs \
    jq \
    libarchive-tools \
    python3 \
    unzip \
    xz-utils \
    zip \
    zstd \
  && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --show-error --silent \
    "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" \
    --output /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip

RUN useradd --create-home --uid 1001 runner

WORKDIR /opt/actions-runner

RUN curl --fail --location --show-error --silent \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    --output /tmp/actions-runner.tar.gz \
  && echo "${RUNNER_SHA256}  /tmp/actions-runner.tar.gz" | sha256sum --check --strict \
  && tar --extract --gzip --file /tmp/actions-runner.tar.gz \
  && rm /tmp/actions-runner.tar.gz \
  && ./bin/installdependencies.sh \
  && mkdir /runner \
  && cp --archive /opt/actions-runner/. /runner/ \
  && chown --recursive runner:runner /runner

COPY --chmod=755 entrypoint.sh /usr/local/bin/hmm-chat-runner

USER runner
WORKDIR /runner

ENTRYPOINT ["/usr/local/bin/hmm-chat-runner"]
