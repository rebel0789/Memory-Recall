require "sinatra/base"
require_relative "app/controllers/items_controller"

get "/health" do
  ItemsController.new.health
end
