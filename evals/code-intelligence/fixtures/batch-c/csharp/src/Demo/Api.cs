namespace Demo.Api;

using Demo.Models;
using Demo.Services;
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("items")]
public sealed class ItemsController : ControllerBase
{
    private readonly ItemService service;

    public ItemsController(ItemService service)
    {
        this.service = service;
    }

    [HttpGet("{id}")]
    public Item Get(string id) => service.Find(id);

    public Item Ambiguous(string id) => service.Load(id);

    public string Describe(Item item) => item.Summary();
}

public static class Routes
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/health", Health);
    }

    private static string Health() => "ok";
}
