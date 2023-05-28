namespace rhyek.BankApis.WebApi;

public class ListTransactionsService
{
    ILogger<ListTransactionsService> logger;

    public ListTransactionsService(ILogger<ListTransactionsService> logger)
    {
        this.logger = logger;
    }

    public Task<List<Transaction>> Get(int? month = null)
    {
        logger.LogInformation("hi!");
        return Task.FromResult(new List<Transaction> { new Transaction("1", 10.00m), new Transaction("2", 20.00m) });
    }
}
