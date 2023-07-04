using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace rhyek.BankApis.WebApi;

public class BankApisContext : DbContext
{
    public DbSet<Transaction> Transactions { get; set; }
    public DbSet<Bank> Banks { get; set; }

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        var dataSourceBuilder =
            new NpgsqlDataSourceBuilder(@"Username=dev;Password=dev;Host=localhost;Port=13005;Database=bank-apis");
        
        dataSourceBuilder.MapEnum<BankId>();
        
        var dataSource = dataSourceBuilder.Build();
        optionsBuilder.UseNpgsql(dataSource);
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        
        modelBuilder.HasPostgresEnum<BankId>();
        modelBuilder.Entity<Bank>()
            .HasData(
                new Bank
                {
                    Id = BankId.BancoIndustrialGt,
                    CountryCode = "GT",
                    DisplayName = "Banco Industrial",
                    CreatedAt = DateTime.UtcNow,
                });
    }
}
