using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using Amazon.Lambda.RuntimeSupport;
using Amazon.Lambda.Serialization.SystemTextJson;

// https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
var handler =
    async (APIGatewayHttpApiV2ProxyRequest evnt, ILambdaContext context) =>
        evnt.Body.ToUpper();

await LambdaBootstrapBuilder.Create(handler, new DefaultLambdaJsonSerializer())
    .Build().RunAsync();
