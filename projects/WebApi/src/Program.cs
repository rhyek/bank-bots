using rhyek.BankApis.WebApi;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// https://zied-ben-tahar.medium.com/aws-lambda-function-urls-with-net-6-minimal-api-727b6d2087a5
builder.Services.AddAWSLambdaHosting(LambdaEventSource.HttpApi);

builder.Services.AddSingleton<UpdateTransactionsService>();
builder.Services.AddSingleton<ListTransactionsService>();

var app = builder.Build();

// Configure the HTTP request pipeline.

app.MapGet("/ready", () => Results.Ok("ok"));

app.MapPost("/update-transactions", async (UpdateTransactionsService updateTransactionsService) =>
    {
        await updateTransactionsService.Update();
        return Results.Ok(new { success = true });
    }
);

app.MapPost("/list-transactions", async (ListTransactionsService listTransactionsService) =>
    {
        var transactions = await listTransactionsService.Get();
        return Results.Ok(new { transactions });
    }
);

if (System.Environment.GetEnvironmentVariable("AWS_LAMBDA_FUNCTION_NAME") != null)
{
    app.Run();
}
else
{
    var port = Environment.GetEnvironmentVariable("PORT") ?? "3000";
    app.Run($"http://*:{port}");
}
