<?php
namespace App;

use App\Contracts\ItemLoader as LoaderContract;
use App\Support\LogsItems;

final class ItemService extends BaseService implements LoaderContract
{
    use LogsItems;

    public function find(string $id): Item
    {
        return new Item($id);
    }

    public function summary(Item $item): string
    {
        return $item->id;
    }
}

function describe(ItemService $service, Item $item): string
{
    return $service->summary($item);
}
