namespace rhyek.BankApis.WebApi;

public class Bank : EntityBase
{
    public required BankId Id { get; set; }
    public required string DisplayName { get; set; }
    public required string CountryCode { get; set; }
}
