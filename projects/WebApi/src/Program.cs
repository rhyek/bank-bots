using rhyek.BankApis.WebApi;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// https://zied-ben-tahar.medium.com/aws-lambda-function-urls-with-net-6-minimal-api-727b6d2087a5
builder.Services.AddAWSLambdaHosting(LambdaEventSource.HttpApi);

builder.Services.AddSingleton<UpdateTransactionsService>();
builder.Services.AddSingleton<ListTransactionsService>();

var app = builder.Build();

// Configure the HTTP request pipeline.

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

if (app.Environment.IsDevelopment())
{
    var port = Environment.GetEnvironmentVariable("PORT") ?? "3000";
    app.Run($"http://*:{port}");
}
else
{
    app.Run();
}
