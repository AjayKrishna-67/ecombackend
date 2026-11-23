import { Component, OnInit } from '@angular/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { map } from 'rxjs/operators';


@Component({
  selector: 'product-sales-graph',
  template: `
    <div style="height: 400px;">
      <canvas baseChart
        [data]="chartData"
        [options]="chartOptions"
        [type]="'bar'">
      </canvas>
    </div>
  `,
})
export class ProductSalesGraphComponent implements OnInit {
  chartData: any = {
    labels: [],
    datasets: []
  };
  chartOptions = {
    responsive: true,
    scales: { y: { beginAtZero: true } },
  };

  constructor(private apollo: Apollo) {}

  ngOnInit() {
    this.apollo.query<{ productSalesGraph: { productName: string; totalQuantity: number }[] }>({
      query: gql`
        query {
          productSalesGraph {
            productName
            totalQuantity
          }
        }
      `,
      fetchPolicy: 'no-cache',
    }).pipe(
      map(result => result.data.productSalesGraph)
    ).subscribe({
      next: products => {
        this.chartData = {
          labels: products.map(p => p.productName),
          datasets: [{
            data: products.map(p => p.totalQuantity),
            label: 'Total Purchased',
            backgroundColor: 'rgba(54, 162, 235, 0.2)',
            borderColor: 'rgba(54, 162, 235, 1)',
            borderWidth: 1
          }]
        };
      },
      error: err => console.error('Error loading graph data', err),
    });
  }
}

