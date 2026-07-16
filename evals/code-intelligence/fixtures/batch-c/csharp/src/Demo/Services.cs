namespace Demo.Services;

using Demo.Models;

public interface IItemLoader
{
    Item Find(string id);
}

public sealed class ItemService : IItemLoader
{
    public Item Find(string id) => new(id);

    public Item Load(string id) => Find(id);

    public Item Load(long id) => Find(id.ToString());
}

public static class ItemExtensions
{
    public static string Summary(this Item item) => item.Id;
}
