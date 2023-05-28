namespace rhyek.BankApis.WebApi;

public class UpdateTransactionsService
{
    ILogger<UpdateTransactionsService> logger;
    public UpdateTransactionsService(ILogger<UpdateTransactionsService> logger)
    {
        this.logger = logger;
    }

    public async Task Update(int? month = null)
    {
        await Task.Delay(0);
        logger.LogInformation("hi");
    }
}
