namespace rhyek.BankApis.WebApi;

public class Transaction : EntityBase
{
    public required string Id { get; set; }
    public Bank Bank { get; set; } = null!;
    public BankId BankId { get; set; }
    public required decimal Amount { get; set; }
}
