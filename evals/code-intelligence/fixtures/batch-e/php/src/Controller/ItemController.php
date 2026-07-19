<?php
namespace App\Controller;

use App\Item;
use Symfony\Component\Routing\Attribute\Route;

final class ItemController
{
    #[Route('/items/{id}', methods: ['GET'])]
    public function show(string $id): Item
    {
        return new Item($id);
    }

    public function store(): Item
    {
        return new Item('new');
    }
}
