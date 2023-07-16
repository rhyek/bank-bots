# https://hub.docker.com/_/microsoft-dotnet-sdk/
# ubuntu 22.04
FROM mcr.microsoft.com/dotnet/sdk:7.0-jammy as build
# needed for AOT when we start using 8.0
# RUN apt-get update && apt-get install --yes clang zlib1g-dev
WORKDIR /app
COPY src/ ./
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
  dotnet publish -c Release -r linux-arm64 --no-self-contained -o /publish

# FROM mcr.microsoft.com/playwright/dotnet:v1.34.0-jammy-arm64
# FROM ubuntu:22.04
FROM public.ecr.aws/lambda/dotnet:7
COPY --from=build /publish ${LAMBDA_TASK_ROOT}
CMD [ "App" ]
