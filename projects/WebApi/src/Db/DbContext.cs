using Microsoft.EntityFrameworkCore;

namespace rhyek.BankApis.WebApi;

public class BankApisContext : DbContext
{
    public DbSet<Transaction> Transactions { get; set; }

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        optionsBuilder.UseNpgsql(@"Username=dev;Password=dev;Host=localhost;Port=13005;Database=bank-apis");
    }
}
