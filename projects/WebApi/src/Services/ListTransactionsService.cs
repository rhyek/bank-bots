using Microsoft.EntityFrameworkCore;

namespace rhyek.BankApis.WebApi;

public class ListTransactionsService
{
    ILogger<ListTransactionsService> logger;
    BankApisContext db;

    public ListTransactionsService(ILogger<ListTransactionsService> logger, BankApisContext db)
    {
        this.logger = logger;
        this.db = db;
    }

    public async Task<List<Transaction>> Get(int? month = null)
    {
        return await db.Transactions.ToListAsync();
    }
}
