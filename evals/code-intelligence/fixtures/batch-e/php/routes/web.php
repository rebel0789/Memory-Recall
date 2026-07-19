<?php
use App\Controller\ItemController;
use Illuminate\Support\Facades\Route;

Route::post('/items', [ItemController::class, 'store']);
