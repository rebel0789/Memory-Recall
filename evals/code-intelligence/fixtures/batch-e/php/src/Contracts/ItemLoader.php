<?php
namespace App\Contracts;

interface ItemLoader
{
    public function find(string $id): object;
}
