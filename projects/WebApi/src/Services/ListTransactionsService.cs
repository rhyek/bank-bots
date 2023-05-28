namespace rhyek.BankApis.WebApi;

public class ListTransactionsService(ILogger<ListTransactionsService> logger)
{
    public Task<List<Transaction>> Get(int? month = null)
    {
        logger.LogInformation("hi");
        return Task.FromResult(new List<Transaction> { new Transaction("1", 10.00m), new Transaction("2", 20.00m) });
    }
}
