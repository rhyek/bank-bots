using NUlid;

namespace rhyek.BankApis.WebApi;

public class UpdateTransactionsService
{
    ILogger<UpdateTransactionsService> logger;
    BankApisContext db;

    public UpdateTransactionsService(ILogger<UpdateTransactionsService> logger, BankApisContext db)
    {
        this.logger = logger;
        this.db = db;
    }

    public async Task Update(int? month = null)
    {
        db.Add(new Transaction
        {
            Id = Ulid.NewUlid().ToString(),
            BankId = BankId.BancoIndustrialGt,
            Amount = new Random().Next(10, 100)
        });
        await db.SaveChangesAsync();
    }
}
