# https://hub.docker.com/_/microsoft-dotnet-sdk/
# ubuntu 22.04
FROM mcr.microsoft.com/dotnet/sdk:7.0-jammy as build
# needed for AOT when we start using 8.0
RUN apt-get update && apt-get install --yes clang zlib1g-dev
WORKDIR /app
COPY *.csproj appsettings.json ./
COPY src/ src/
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
  dotnet publish -r linux-arm64 -c Release -o /publish

# FROM mcr.microsoft.com/playwright/dotnet:v1.34.0-jammy-arm64
# FROM ubuntu:22.04
FROM mcr.microsoft.com/dotnet/runtime:7.0-jammy
WORKDIR /app
COPY --from=build /publish .
CMD [ "dotnet", "WebApi.dll" ]
